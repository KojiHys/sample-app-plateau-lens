#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import {
  APPLICATION_NAME,
  APPLICATION_REGION,
} from "./config.ts";
import { PlateauLensStack } from "./plateau-lens-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

new PlateauLensStack(app, APPLICATION_NAME, {
  stackName: APPLICATION_NAME,
  env:
    account === undefined
      ? { region: APPLICATION_REGION }
      : { account, region: APPLICATION_REGION },
});
