import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { App } from "aws-cdk-lib";
import {
  Annotations,
  Match,
  Template,
} from "aws-cdk-lib/assertions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLICATION_NAME,
  APPLICATION_REGION,
  DEFAULT_TILESET_URL,
} from "../../infrastructure/config.ts";
import { PlateauLensStack } from "../../infrastructure/plateau-lens-stack.ts";

const TEST_ACCOUNT = "111111111111";
const FIXTURE_DIRECTORY = resolve("test/infrastructure/fixtures");
const WEB_FIXTURE_PATH = join(FIXTURE_DIRECTORY, "dist");
const LAMBDA_FIXTURE_PATH = join(FIXTURE_DIRECTORY, "lambda-handler.ts");

type CloudFormationResource = {
  readonly Type: string;
  readonly Properties: Record<string, unknown>;
  readonly DependsOn?: string | string[];
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
};

interface SynthesizedFixture {
  readonly outdir: string;
  readonly stack: PlateauLensStack;
  readonly template: Template;
}

const temporaryDirectories: string[] = [];

function synthesizeFixture(
  context: Record<string, unknown> = {},
): SynthesizedFixture {
  const outdir = mkdtempSync(join(tmpdir(), "plateau-lens-cdk-"));
  temporaryDirectories.push(outdir);
  const app = new App({ context, outdir });
  const stack = new PlateauLensStack(app, APPLICATION_NAME, {
    env: {
      account: TEST_ACCOUNT,
      region: APPLICATION_REGION,
    },
    lambdaEntryPath: LAMBDA_FIXTURE_PATH,
    webAssetPath: WEB_FIXTURE_PATH,
  });
  app.synth();
  return {
    outdir,
    stack,
    template: Template.fromStack(stack),
  };
}

function resourcesOf(
  template: Template,
  resourceType: string,
): CloudFormationResource[] {
  return Object.values(template.findResources(resourceType)) as CloudFormationResource[];
}

function findRuntimeConfigAsset(outdir: string): string {
  for (const entry of readdirSync(outdir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(outdir, entry.name, "runtime-config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Synthesized runtime-config.json asset was not found");
}

function dependencyList(resource: CloudFormationResource): string[] {
  if (resource.DependsOn === undefined) {
    return [];
  }
  return Array.isArray(resource.DependsOn)
    ? resource.DependsOn
    : [resource.DependsOn];
}

function actionList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error("IAM Action was not a string or string array");
}

let withoutBudget: SynthesizedFixture;
let withBudgetAndDevOrigin: SynthesizedFixture;

beforeAll(() => {
  withoutBudget = synthesizeFixture();
  withBudgetAndDevOrigin = synthesizeFixture({
    budgetEmail: "alerts@example.com",
    budgetAmount: "25.50",
    devOrigin: "http://localhost:5173/",
    fallbackEnabled: "true",
  });
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("PlateauLensStack", () => {
  it("uses the fixed stack name and region", () => {
    expect(withoutBudget.stack.stackName).toBe(APPLICATION_NAME);
    expect(withoutBudget.stack.region).toBe("us-east-1");
  });

  it("creates the views table with the required owner index", () => {
    withoutBudget.template.hasResource("AWS::DynamoDB::Table", {
      Properties: {
        TableName: `${APPLICATION_NAME}-views`,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "viewId", KeyType: "HASH" }],
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "viewId", AttributeType: "S" },
          { AttributeName: "ownerSub", AttributeType: "S" },
          { AttributeName: "createdAt", AttributeType: "S" },
        ]),
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "ownerSub", KeyType: "HASH" },
              { AttributeName: "createdAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: ["title"],
            },
          },
        ],
      },
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });

  it("configures the Node.js 22 function and short-retention logs", () => {
    withoutBudget.template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: `${APPLICATION_NAME}-views-api`,
      Handler: "index.handler",
      Runtime: "nodejs22.x",
      Timeout: 10,
      MemorySize: 256,
      Environment: {
        Variables: {
          TABLE_NAME: { Ref: Match.stringLikeRegexp("ViewsTable") },
          GSI_NAME: "GSI1",
          APP_BASE_URL: {
            "Fn::Join": [
              "",
              Match.arrayWith([
                "https://",
                Match.objectLike({ "Fn::GetAtt": Match.anyValue() }),
                "/",
              ]),
            ],
          },
        },
      },
    });
    withoutBudget.template.hasResource("AWS::Logs::LogGroup", {
      Properties: {
        LogGroupName: `/aws/lambda/${APPLICATION_NAME}-views-api`,
        RetentionInDays: 7,
      },
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
  });

  it("limits the views function role to item operations and GSI Query", () => {
    const role = resourcesOf(withoutBudget.template, "AWS::IAM::Role").find(
      (resource) =>
        resource.Properties.RoleName === `${APPLICATION_NAME}-views-api-role`,
    );
    expect(role).toBeDefined();
    if (role === undefined) {
      return;
    }

    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    const policies = role.Properties.Policies as Array<{
      PolicyName: string;
      PolicyDocument: {
        Statement: Array<Record<string, unknown>>;
      };
    }>;
    expect(policies.map((policy) => policy.PolicyName).sort()).toEqual([
      `${APPLICATION_NAME}-views-api-dynamodb`,
      `${APPLICATION_NAME}-views-api-logs`,
    ]);

    const statements = policies.flatMap(
      (policy) => policy.PolicyDocument.Statement,
    );
    const dynamoStatements = statements.filter((statement) =>
      actionList(statement.Action).some((action) => action.startsWith("dynamodb:")),
    );
    expect(dynamoStatements).toHaveLength(2);
    expect(
      dynamoStatements.flatMap((statement) => actionList(statement.Action)).sort(),
    ).toEqual([
      "dynamodb:DeleteItem",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]);

    const queryStatement = dynamoStatements.find((statement) =>
      actionList(statement.Action).includes("dynamodb:Query"),
    );
    expect(queryStatement).toBeDefined();
    expect(JSON.stringify(queryStatement?.Resource)).toContain("/index/GSI1");
    expect(JSON.stringify(withoutBudget.template.toJSON())).not.toMatch(
      /dynamodb:(?:Scan|UpdateItem)/u,
    );
  });

  it("keeps both encrypted S3 buckets private and destroyable", () => {
    withoutBudget.template.resourcePropertiesCountIs(
      "AWS::S3::Bucket",
      {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: "AES256",
              },
            },
          ],
        },
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      2,
    );

    const buckets = resourcesOf(withoutBudget.template, "AWS::S3::Bucket");
    expect(buckets).toHaveLength(2);
    expect(
      buckets.map((bucket) => JSON.stringify(bucket.Properties.BucketName)).sort(),
    ).toEqual(
      [
        `${APPLICATION_NAME}-tiles-`,
        `${APPLICATION_NAME}-web-`,
      ].map((prefix) =>
        JSON.stringify({
          "Fn::Join": ["", [prefix, { Ref: "AWS::AccountId" }]],
        }),
      ),
    );
    for (const bucket of buckets) {
      expect(bucket.Properties.WebsiteConfiguration).toBeUndefined();
      expect(bucket.DeletionPolicy).toBe("Delete");
      expect(bucket.UpdateReplacePolicy).toBe("Delete");
    }
  });

  it("uses two OAC-only origins, default-only SPA rewrites, and security headers", () => {
    withoutBudget.template.resourceCountIs(
      "AWS::CloudFront::CloudFrontOriginAccessIdentity",
      0,
    );
    withoutBudget.template.resourcePropertiesCountIs(
      "AWS::CloudFront::OriginAccessControl",
      {
        OriginAccessControlConfig: {
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      },
      2,
    );
    withoutBudget.template.hasResourceProperties("AWS::CloudFront::Function", {
      AutoPublish: true,
      FunctionConfig: {
        Comment: `${APPLICATION_NAME} extensionless SPA navigation rewrite`,
        Runtime: "cloudfront-js-2.0",
      },
      FunctionCode: Match.stringLikeRegexp(
        "uri !== '/' && lastSegment\\.indexOf\\('\\.'\\) === -1",
      ),
    });
    withoutBudget.template.hasResourceProperties(
      "AWS::CloudFront::Distribution",
      {
        DistributionConfig: {
          DefaultRootObject: "index.html",
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: "redirect-to-https",
            ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03",
            FunctionAssociations: [
              {
                EventType: "viewer-request",
                FunctionARN: Match.objectLike({
                  "Fn::GetAtt": Match.anyValue(),
                }),
              },
            ],
          }),
          CacheBehaviors: [
            Match.objectLike({
              PathPattern: "/tiles/*",
              ViewerProtocolPolicy: "redirect-to-https",
              ResponseHeadersPolicyId: "67f7725c-6f97-4210-82d7-5512b31e9d03",
            }),
          ],
          Origins: Match.arrayWith([
            Match.objectLike({
              OriginAccessControlId: Match.anyValue(),
              S3OriginConfig: { OriginAccessIdentity: "" },
            }),
            Match.objectLike({
              OriginAccessControlId: Match.anyValue(),
              S3OriginConfig: { OriginAccessIdentity: "" },
            }),
          ]),
        },
      },
    );

    const distributions = resourcesOf(
      withoutBudget.template,
      "AWS::CloudFront::Distribution",
    );
    expect(distributions).toHaveLength(1);
    const distributionConfig = distributions[0]?.Properties.DistributionConfig as
      | {
          CacheBehaviors?: Array<Record<string, unknown>>;
          CustomErrorResponses?: unknown;
          DefaultCacheBehavior?: Record<string, unknown>;
        }
      | undefined;
    expect(distributionConfig?.CustomErrorResponses).toBeUndefined();
    expect(distributionConfig?.DefaultCacheBehavior?.FunctionAssociations).toHaveLength(
      1,
    );
    expect(distributionConfig?.CacheBehaviors?.[0]?.FunctionAssociations).toBeUndefined();

    const bucketPolicies = resourcesOf(
      withoutBudget.template,
      "AWS::S3::BucketPolicy",
    );
    expect(bucketPolicies).toHaveLength(2);
    for (const policy of bucketPolicies) {
      const document = policy.Properties.PolicyDocument as {
        Statement: Array<Record<string, unknown>>;
      };
      const cloudFrontRead = document.Statement.find(
        (statement) =>
          statement.Effect === "Allow" &&
          actionList(statement.Action).includes("s3:GetObject"),
      );
      expect(cloudFrontRead).toBeDefined();
      expect(cloudFrontRead?.Principal).toEqual({
        Service: "cloudfront.amazonaws.com",
      });
      expect(JSON.stringify(cloudFrontRead?.Condition)).toContain(
        "AWS:SourceArn",
      );
      expect(
        document.Statement.some(
          (statement) =>
            statement.Effect === "Allow" &&
            JSON.stringify(statement.Principal) === JSON.stringify({ AWS: "*" }),
        ),
      ).toBe(false);
    }
  });

  it("creates an admin-only public Cognito SPA client with exact callbacks", () => {
    withoutBudget.template.hasResource("AWS::Cognito::UserPool", {
      Properties: {
        UserPoolName: APPLICATION_NAME,
        AdminCreateUserConfig: {
          AllowAdminCreateUserOnly: true,
        },
        UsernameAttributes: ["email"],
      },
      DeletionPolicy: "Delete",
      UpdateReplacePolicy: "Delete",
    });
    withoutBudget.template.hasResourceProperties(
      "AWS::Cognito::UserPoolClient",
      {
        ClientName: `${APPLICATION_NAME}-spa`,
        GenerateSecret: false,
        AllowedOAuthFlows: ["code"],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: ["openid", "email", "profile"],
        SupportedIdentityProviders: ["COGNITO"],
      },
    );

    const client = resourcesOf(
      withoutBudget.template,
      "AWS::Cognito::UserPoolClient",
    )[0];
    expect(client).toBeDefined();
    if (client === undefined) {
      return;
    }
    expect(client.Properties.CallbackURLs).toEqual(client.Properties.LogoutURLs);
    const callback = (
      client.Properties.CallbackURLs as Array<{
        "Fn::Join": [string, unknown[]];
      }>
    )[0];
    expect(callback?.["Fn::Join"][1].at(-1)).toBe("/");

    const developmentClient = resourcesOf(
      withBudgetAndDevOrigin.template,
      "AWS::Cognito::UserPoolClient",
    )[0];
    expect(developmentClient?.Properties.CallbackURLs).toContain(
      "http://localhost:5173/",
    );
    expect(developmentClient?.Properties.LogoutURLs).toEqual(
      developmentClient?.Properties.CallbackURLs,
    );

    const domain = resourcesOf(
      withoutBudget.template,
      "AWS::Cognito::UserPoolDomain",
    )[0];
    expect(domain).toBeDefined();
    if (domain !== undefined) {
      const domainParts = (domain.Properties.Domain as { "Fn::Join": [string, unknown[]] })[
        "Fn::Join"
      ][1];
      expect(domainParts[0]).toBe(`${APPLICATION_NAME}-`);
      expect(domainParts.at(-1)).toMatch(/^-[a-f0-9]{8}$/u);
      expect(domain.Properties.ManagedLoginVersion).toBe(2);
    }

    const userPoolLogicalId = withoutBudget.template.getResourceId(
      "AWS::Cognito::UserPool",
    );
    const clientLogicalId = withoutBudget.template.getResourceId(
      "AWS::Cognito::UserPoolClient",
    );
    const domainLogicalId = withoutBudget.template.getResourceId(
      "AWS::Cognito::UserPoolDomain",
    );
    withoutBudget.template.resourceCountIs(
      "AWS::Cognito::ManagedLoginBranding",
      1,
    );
    withoutBudget.template.hasResourceProperties(
      "AWS::Cognito::ManagedLoginBranding",
      {
        UserPoolId: { Ref: userPoolLogicalId },
        ClientId: { Ref: clientLogicalId },
        UseCognitoProvidedValues: true,
      },
    );
    const branding = resourcesOf(
      withoutBudget.template,
      "AWS::Cognito::ManagedLoginBranding",
    )[0];
    expect(branding).toBeDefined();
    if (branding === undefined) {
      throw new Error("Synthesized managed login branding was not found");
    }
    expect(branding.Properties.Assets).toBeUndefined();
    expect(branding.Properties.Settings).toBeUndefined();
    expect(dependencyList(branding)).toContain(domainLogicalId);
  });

  it("protects only create, list, and delete routes with the user-pool authorizer", () => {
    withoutBudget.template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    withoutBudget.template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
      Name: `${APPLICATION_NAME}-user-pool-authorizer`,
      JwtConfiguration: Match.objectLike({
        Audience: [Match.objectLike({ Ref: Match.anyValue() })],
      }),
    });

    const routes = resourcesOf(
      withoutBudget.template,
      "AWS::ApiGatewayV2::Route",
    );
    expect(routes).toHaveLength(4);
    const routesByKey = new Map(
      routes.map((route) => [route.Properties.RouteKey as string, route.Properties]),
    );
    expect([...routesByKey.keys()].sort()).toEqual([
      "DELETE /views/{viewId}",
      "GET /views",
      "GET /views/{viewId}",
      "POST /views",
    ]);

    for (const routeKey of [
      "POST /views",
      "GET /views",
      "DELETE /views/{viewId}",
    ]) {
      expect(routesByKey.get(routeKey)?.AuthorizationType).toBe("JWT");
      expect(routesByKey.get(routeKey)?.AuthorizerId).toBeDefined();
    }
    expect(routesByKey.get("GET /views/{viewId}")?.AuthorizationType).toBe(
      "NONE",
    );
    expect(routesByKey.get("GET /views/{viewId}")?.AuthorizerId).toBeUndefined();
    expect(
      new Set(routes.map((route) => JSON.stringify(route.Properties.Target))).size,
    ).toBe(1);
  });

  it("limits CORS to CloudFront and throttles only write routes", () => {
    withoutBudget.template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: `${APPLICATION_NAME}-api`,
      ProtocolType: "HTTP",
      CorsConfiguration: {
        AllowHeaders: ["Authorization", "Content-Type"],
        AllowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        AllowOrigins: [
          {
            "Fn::Join": [
              "",
              ["https://", Match.objectLike({ "Fn::GetAtt": Match.anyValue() })],
            ],
          },
        ],
        MaxAge: 3600,
      },
    });
    withoutBudget.template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
    });

    const stage = resourcesOf(
      withoutBudget.template,
      "AWS::ApiGatewayV2::Stage",
    )[0];
    expect(stage).toBeDefined();
    if (stage === undefined) {
      throw new Error("Synthesized HTTP API stage was not found");
    }
    const synthesizedRouteSettings = stage.Properties.RouteSettings;
    if (
      synthesizedRouteSettings === null ||
      typeof synthesizedRouteSettings !== "object" ||
      Array.isArray(synthesizedRouteSettings)
    ) {
      throw new Error("Synthesized route settings were not an object");
    }
    expect(synthesizedRouteSettings).toEqual({
      "POST /views": {
        ThrottlingBurstLimit: 5,
        ThrottlingRateLimit: 2,
      },
      "DELETE /views/{viewId}": {
        ThrottlingBurstLimit: 5,
        ThrottlingRateLimit: 2,
      },
    });

    const routeResources = withoutBudget.template.findResources(
      "AWS::ApiGatewayV2::Route",
    ) as Record<string, CloudFormationResource>;
    const throttledRouteLogicalIds = Object.entries(routeResources)
      .filter(([, route]) =>
        Object.hasOwn(
          synthesizedRouteSettings,
          route.Properties.RouteKey as string,
        ),
      )
      .map(([logicalId]) => logicalId)
      .sort();
    expect(throttledRouteLogicalIds).toHaveLength(2);
    expect(dependencyList(stage).sort()).toEqual(throttledRouteLogicalIds);

    const api = resourcesOf(
      withBudgetAndDevOrigin.template,
      "AWS::ApiGatewayV2::Api",
    )[0];
    expect(api).toBeDefined();
    const cors = api?.Properties.CorsConfiguration as
      | { AllowOrigins: unknown[] }
      | undefined;
    expect(cors?.AllowOrigins).toHaveLength(2);
    expect(cors?.AllowOrigins).toContain("http://localhost:5173");
    expect(JSON.stringify(cors?.AllowOrigins)).not.toContain('"*"');
  });

  it("deploys dist plus generated runtime config and invalidates CloudFront", () => {
    withoutBudget.template.hasResourceProperties("Custom::CDKBucketDeployment", {
      SourceBucketNames: Match.anyValue(),
      SourceObjectKeys: Match.anyValue(),
      DestinationBucketName: Match.objectLike({ Ref: Match.anyValue() }),
      DistributionId: Match.objectLike({ Ref: Match.anyValue() }),
      DistributionPaths: ["/*"],
      OutputObjectKeys: false,
      Prune: true,
      RetainOnDelete: false,
    });

    const deployment = resourcesOf(
      withoutBudget.template,
      "Custom::CDKBucketDeployment",
    )[0];
    expect(deployment).toBeDefined();
    if (deployment === undefined) {
      throw new Error("Synthesized web deployment was not found");
    }
    const stageLogicalId = withoutBudget.template.getResourceId(
      "AWS::ApiGatewayV2::Stage",
    );
    const brandingLogicalId = withoutBudget.template.getResourceId(
      "AWS::Cognito::ManagedLoginBranding",
    );
    expect(dependencyList(deployment)).toEqual(
      expect.arrayContaining([stageLogicalId, brandingLogicalId]),
    );
    expect(deployment.Properties.SourceBucketNames).toHaveLength(2);
    expect(deployment?.Properties.SourceObjectKeys).toHaveLength(2);
    const markers = deployment?.Properties.SourceMarkers as
      | Array<Record<string, unknown>>
      | undefined;
    expect(markers).toHaveLength(2);
    expect(Object.keys(markers?.[1] ?? {})).toHaveLength(4);

    const disabledRuntimeConfigText = readFileSync(
      findRuntimeConfigAsset(withoutBudget.outdir),
      "utf8",
    );
    for (const key of [
      "apiBaseUrl",
      "awsRegion",
      "cognitoDomain",
      "fallbackTilesetUrl",
      "redirectUri",
      "tilesetUrl",
      "userPoolClientId",
    ]) {
      expect(disabledRuntimeConfigText).toContain(`\"${key}\":`);
    }
    expect(disabledRuntimeConfigText).toContain(`\"${APPLICATION_REGION}\"`);
    expect(disabledRuntimeConfigText).toContain(
      `\"fallbackTilesetUrl\":\"\"`,
    );
    expect(disabledRuntimeConfigText).toContain(
      JSON.stringify(DEFAULT_TILESET_URL),
    );

    const enabledRuntimeConfigText = readFileSync(
      findRuntimeConfigAsset(withBudgetAndDevOrigin.outdir),
      "utf8",
    );
    expect(enabledRuntimeConfigText).toContain(
      `\"fallbackTilesetUrl\":<<marker:`,
    );
    const enabledDeployment = resourcesOf(
      withBudgetAndDevOrigin.template,
      "Custom::CDKBucketDeployment",
    )[0];
    const enabledMarkers = enabledDeployment?.Properties.SourceMarkers as
      | Array<Record<string, unknown>>
      | undefined;
    expect(JSON.stringify(enabledMarkers)).toContain("/tiles/tileset.json");
  });

  it("warns without budgetEmail and creates the requested actual-spend budget when set", () => {
    withoutBudget.template.resourceCountIs("AWS::Budgets::Budget", 0);
    Annotations.fromStack(withoutBudget.stack).hasWarning(
      "*",
      Match.stringLikeRegexp("REQUIRED BEFORE DEPLOYMENT.*budgetEmail"),
    );

    withBudgetAndDevOrigin.template.hasResourceProperties(
      "AWS::Budgets::Budget",
      {
        Budget: {
          BudgetName: `${APPLICATION_NAME}-monthly-cost`,
          BudgetType: "COST",
          TimeUnit: "MONTHLY",
          BudgetLimit: {
            Amount: 25.5,
            Unit: "USD",
          },
        },
        NotificationsWithSubscribers: [
          {
            Notification: {
              ComparisonOperator: "GREATER_THAN",
              NotificationType: "ACTUAL",
              Threshold: 80,
              ThresholdType: "PERCENTAGE",
            },
            Subscribers: [
              {
                Address: "alerts@example.com",
                SubscriptionType: "EMAIL",
              },
            ],
          },
        ],
      },
    );
  });

  it("publishes all operational outputs", () => {
    expect(Object.keys(withoutBudget.template.toJSON().Outputs).sort()).toEqual([
      "ApiEndpoint",
      "CloudFrontUrl",
      "CognitoLoginDomain",
      "TilesBucketName",
      "UserPoolClientId",
      "UserPoolId",
      "WebBucketName",
    ]);
  });
});
