import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Annotations,
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import {
  APPLICATION_NAME,
  APPLICATION_REGION,
  DEFAULT_TILESET_URL,
  loadInfrastructureContext,
} from "./config.ts";

const GSI_NAME = "GSI1";
const TABLE_NAME = `${APPLICATION_NAME}-views`;
const FUNCTION_NAME = `${APPLICATION_NAME}-views-api`;
const API_NAME = `${APPLICATION_NAME}-api`;
const WRITE_THROTTLE_BURST_LIMIT = 5;
const WRITE_THROTTLE_RATE_LIMIT = 2;

type CloudFormationRouteSettings = {
  readonly ThrottlingBurstLimit: number;
  readonly ThrottlingRateLimit: number;
};

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(SOURCE_DIRECTORY, "..");
const DEFAULT_WEB_ASSET_PATH = resolve(PROJECT_DIRECTORY, "dist");
const DEFAULT_LAMBDA_ENTRY_PATH = resolve(
  PROJECT_DIRECTORY,
  "lambda/views-handler.ts",
);
const COGNITO_DOMAIN_HASH = createHash("sha256")
  .update(`${APPLICATION_NAME}:cognito-domain:v1`)
  .digest("hex")
  .slice(0, 8);

export interface PlateauLensStackProps extends StackProps {
  /** Override only to use a small static-asset fixture in assertion tests. */
  readonly webAssetPath?: string;
  /** Override only to use a small Lambda entry fixture in assertion tests. */
  readonly lambdaEntryPath?: string;
}

function baseStackProps(props: PlateauLensStackProps | undefined): StackProps {
  if (props === undefined) {
    return { stackName: APPLICATION_NAME };
  }
  const { lambdaEntryPath: _lambdaEntryPath, webAssetPath: _webAssetPath, ...base } =
    props;
  return { ...base, stackName: APPLICATION_NAME };
}

export class PlateauLensStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props?: PlateauLensStackProps,
  ) {
    super(scope, id, baseStackProps(props));

    if (!Token.isUnresolved(this.region) && this.region !== APPLICATION_REGION) {
      throw new Error(`The stack region must be ${APPLICATION_REGION}`);
    }

    const context = loadInfrastructureContext(this);
    const accountId = Aws.ACCOUNT_ID;

    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: `${APPLICATION_NAME}-web-${accountId}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const tilesBucket = new s3.Bucket(this, "TilesBucket", {
      bucketName: `${APPLICATION_NAME}-tiles-${accountId}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CDK 2.270's Bucket/IBucket declarations are structurally incompatible when
    // TypeScript 7 checks exact optional properties, although Bucket implements IBucket.
    const webBucketRef = webBucket as unknown as s3.IBucket;
    const tilesBucketRef = tilesBucket as unknown as s3.IBucket;

    const webOriginAccessControl = new cloudfront.S3OriginAccessControl(
      this,
      "WebOriginAccessControl",
      {
        originAccessControlName: `${APPLICATION_NAME}-web-oac`,
        description: `${APPLICATION_NAME} SPA origin access control`,
      },
    );
    const tilesOriginAccessControl = new cloudfront.S3OriginAccessControl(
      this,
      "TilesOriginAccessControl",
      {
        originAccessControlName: `${APPLICATION_NAME}-tiles-oac`,
        description: `${APPLICATION_NAME} fallback tiles origin access control`,
      },
    );

    const webOrigin = S3BucketOrigin.withOriginAccessControl(webBucketRef, {
      originAccessControl: webOriginAccessControl,
    });
    const tilesOrigin = S3BucketOrigin.withOriginAccessControl(tilesBucketRef, {
      originAccessControl: tilesOriginAccessControl,
    });
    const secureReadBehavior = {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    } as const;

    const spaRewriteFunction = new cloudfront.Function(this, "SpaRewriteFunction", {
      comment: `${APPLICATION_NAME} extensionless SPA navigation rewrite`,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri !== '/' && lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `${APPLICATION_NAME} web distribution`,
      defaultBehavior: {
        origin: webOrigin,
        ...secureReadBehavior,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewriteFunction,
          },
        ],
      },
      additionalBehaviors: {
        "/tiles/*": {
          origin: tilesOrigin,
          ...secureReadBehavior,
        },
      },
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    const appOrigin = `https://${distribution.distributionDomainName}`;
    const appUrl = `${appOrigin}/`;
    const fallbackTilesetUrl = context.fallbackEnabled
      ? `${appOrigin}/tiles/tileset.json`
      : "";

    const table = new dynamodb.Table(this, "ViewsTable", {
      tableName: TABLE_NAME,
      partitionKey: {
        name: "viewId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName: GSI_NAME,
      partitionKey: {
        name: "ownerSub",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "createdAt",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["title"],
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: APPLICATION_NAME,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: false,
      },
      autoVerify: {
        email: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const developmentCallbackUrl =
      context.devOrigin === undefined ? undefined : `${context.devOrigin}/`;
    const callbackUrls = [
      appUrl,
      ...(developmentCallbackUrl === undefined ? [] : [developmentCallbackUrl]),
    ];

    const userPoolClient = userPool.addClient("SpaClient", {
      userPoolClientName: `${APPLICATION_NAME}-spa`,
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls,
        logoutUrls: callbackUrls,
        defaultRedirectUri: appUrl,
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    });

    const userPoolDomain = userPool.addDomain("ManagedLoginDomain", {
      cognitoDomain: {
        domainPrefix: `${APPLICATION_NAME}-${accountId}-${COGNITO_DOMAIN_HASH}`,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const cfnUserPoolDomain = userPoolDomain.node.defaultChild;
    if (!(cfnUserPoolDomain instanceof cognito.CfnUserPoolDomain)) {
      throw new Error("The managed login domain is not a CfnUserPoolDomain");
    }
    const managedLoginBranding = new cognito.CfnManagedLoginBranding(
      this,
      "ManagedLoginBranding",
      {
        userPoolId: userPool.userPoolId,
        clientId: userPoolClient.userPoolClientId,
        useCognitoProvidedValues: true,
      },
    );
    managedLoginBranding.addResourceDependency(cfnUserPoolDomain);
    const cognitoDomainUrl = userPoolDomain.baseUrl();

    const functionLogGroup = new logs.LogGroup(this, "ViewsFunctionLogGroup", {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const functionRole = new iam.Role(this, "ViewsFunctionRole", {
      roleName: `${APPLICATION_NAME}-views-api-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `${APPLICATION_NAME} views API execution role`,
      inlinePolicies: {
        [`${APPLICATION_NAME}-views-api-logs`]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "FunctionLogDelivery",
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [`${functionLogGroup.logGroupArn}:*`],
            }),
          ],
        }),
        [`${APPLICATION_NAME}-views-api-dynamodb`]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "BaseTableItemAccess",
              actions: [
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:DeleteItem",
              ],
              resources: [table.tableArn],
            }),
            new iam.PolicyStatement({
              sid: "ViewsByOwnerQuery",
              actions: ["dynamodb:Query"],
              resources: [`${table.tableArn}/index/${GSI_NAME}`],
            }),
          ],
        }),
      },
    });

    const viewsFunction = new NodejsFunction(this, "ViewsFunction", {
      functionName: FUNCTION_NAME,
      description: `${APPLICATION_NAME} views HTTP API handler`,
      entry: props?.lambdaEntryPath ?? DEFAULT_LAMBDA_ENTRY_PATH,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        GSI_NAME,
        APP_BASE_URL: appUrl,
      },
      logGroup: functionLogGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      role: functionRole,
      depsLockFilePath: resolve(PROJECT_DIRECTORY, "package-lock.json"),
      projectRoot: PROJECT_DIRECTORY,
      bundling: {
        bundleAwsSDK: true,
        forceDockerBundling: false,
        minify: true,
        sourceMap: false,
        target: "node22",
      },
    });

    const corsOrigins =
      context.devOrigin === undefined
        ? [appOrigin]
        : [appOrigin, context.devOrigin];
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: API_NAME,
      description: `${APPLICATION_NAME} views API`,
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowHeaders: ["Authorization", "Content-Type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(1),
      },
    });

    const viewsIntegration = new HttpLambdaIntegration(
      "ViewsLambdaIntegration",
      viewsFunction,
    );
    const userPoolAuthorizer = new HttpUserPoolAuthorizer(
      "ViewsUserPoolAuthorizer",
      userPool,
      {
        authorizerName: `${APPLICATION_NAME}-user-pool-authorizer`,
        userPoolClients: [userPoolClient],
      },
    );

    const routes = [
      ...httpApi.addRoutes({
        path: "/views",
        methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET],
        integration: viewsIntegration,
        authorizer: userPoolAuthorizer,
      }),
      ...httpApi.addRoutes({
        path: "/views/{viewId}",
        methods: [apigwv2.HttpMethod.DELETE],
        integration: viewsIntegration,
        authorizer: userPoolAuthorizer,
      }),
      ...httpApi.addRoutes({
        path: "/views/{viewId}",
        methods: [apigwv2.HttpMethod.GET],
        integration: viewsIntegration,
      }),
    ];

    const defaultStage = httpApi.defaultStage;
    if (defaultStage === undefined) {
      throw new Error("The HTTP API default stage was not created");
    }
    const cfnStage = defaultStage.node.defaultChild;
    if (!(cfnStage instanceof apigwv2.CfnStage)) {
      throw new Error("The HTTP API default stage is not a CfnStage");
    }
    const routeSettings = {
      "POST /views": {
        ThrottlingBurstLimit: WRITE_THROTTLE_BURST_LIMIT,
        ThrottlingRateLimit: WRITE_THROTTLE_RATE_LIMIT,
      },
      "DELETE /views/{viewId}": {
        ThrottlingBurstLimit: WRITE_THROTTLE_BURST_LIMIT,
        ThrottlingRateLimit: WRITE_THROTTLE_RATE_LIMIT,
      },
    } satisfies Record<string, CloudFormationRouteSettings>;
    cfnStage.routeSettings = routeSettings;

    for (const route of routes) {
      const cfnRoute = route.node.defaultChild;
      if (!(cfnRoute instanceof apigwv2.CfnRoute)) {
        throw new Error(`The HTTP API route ${route.node.path} is not a CfnRoute`);
      }
      if (cfnRoute.routeKey in routeSettings) {
        cfnStage.addResourceDependency(cfnRoute);
      }
    }

    const webDeployment = new s3deploy.BucketDeployment(this, "WebDeployment", {
      sources: [
        s3deploy.Source.asset(
          props?.webAssetPath ?? DEFAULT_WEB_ASSET_PATH,
          {
            exclude: ["runtime-config.json"],
          },
        ),
        s3deploy.Source.jsonData("runtime-config.json", {
          apiBaseUrl: httpApi.apiEndpoint,
          awsRegion: APPLICATION_REGION,
          cognitoDomain: cognitoDomainUrl,
          fallbackTilesetUrl,
          redirectUri: appUrl,
          tilesetUrl: DEFAULT_TILESET_URL,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
      destinationBucket: webBucketRef,
      distribution,
      distributionPaths: ["/*"],
      outputObjectKeys: false,
      prune: true,
      retainOnDelete: false,
    });
    webDeployment.node.addDependency(cfnStage, managedLoginBranding);

    if (context.budgetEmail === undefined) {
      Annotations.of(this).addWarningV2(
        `${APPLICATION_NAME}:budgetEmail-required`,
        "REQUIRED BEFORE DEPLOYMENT: set CDK context budgetEmail to create the monthly cost budget notification.",
      );
    } else {
      new budgets.CfnBudget(this, "MonthlyCostBudget", {
        budget: {
          budgetName: `${APPLICATION_NAME}-monthly-cost`,
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: context.budgetAmount,
            unit: "USD",
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                address: context.budgetEmail,
                subscriptionType: "EMAIL",
              },
            ],
          },
        ],
      });
    }

    new CfnOutput(this, "CloudFrontUrl", {
      value: appUrl,
      description: `${APPLICATION_NAME} application URL`,
    });
    new CfnOutput(this, "ApiEndpoint", {
      value: httpApi.apiEndpoint,
      description: `${APPLICATION_NAME} HTTP API endpoint`,
    });
    new CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: `${APPLICATION_NAME} Cognito user pool ID`,
    });
    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: `${APPLICATION_NAME} Cognito SPA client ID`,
    });
    new CfnOutput(this, "CognitoLoginDomain", {
      value: cognitoDomainUrl,
      description: `${APPLICATION_NAME} Cognito managed login domain`,
    });
    new CfnOutput(this, "WebBucketName", {
      value: webBucket.bucketName,
      description: `${APPLICATION_NAME} SPA bucket name`,
    });
    new CfnOutput(this, "TilesBucketName", {
      value: tilesBucket.bucketName,
      description: `${APPLICATION_NAME} fallback tiles bucket name`,
    });
  }
}
