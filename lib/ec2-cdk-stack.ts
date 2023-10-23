import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';

import {
  Vpc, SubnetType, Peer, Port, AmazonLinuxGeneration,
  AmazonLinuxCpuType, Instance, SecurityGroup, AmazonLinuxImage,
  InstanceClass, InstanceSize, InstanceType
} from 'aws-cdk-lib/aws-ec2';

import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Pipeline, Artifact } from 'aws-cdk-lib/aws-codepipeline';
import { GitHubSourceAction, CodeBuildAction, CodeDeployServerDeployAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { PipelineProject, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { ServerDeploymentGroup, ServerApplication, InstanceTagSet } from 'aws-cdk-lib/aws-codedeploy';
import { SecretValue } from 'aws-cdk-lib';

export class Ec2CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webServerRole = new Role(this, "ec2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com")
    })

    webServerRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSManagedInstanceCore")
    );

    webServerRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2RoleforAWSCodeDeploy")
    )

    const vpc = new Vpc(this, 'main_vpc', {
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'pub01',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'pub02',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'pub03',
          subnetType: SubnetType.PUBLIC,
        }
      ]
    });

    const webSg = new SecurityGroup(this, 'web_sg', {
      vpc,
      description: "Allows inbound HTTP trafiic to the web server",
      allowAllOutbound: true,
    });

    webSg.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80)
    );

    const ami = new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: AmazonLinuxCpuType.X86_64,
    });

    const webServer = new Instance(this, 'web_server', {
      vpc,
      instanceType: InstanceType.of(
        InstanceClass.T2,
        InstanceSize.MICRO
      ),
      machineImage: ami,
      securityGroup: webSg,
      role: webServerRole,
    });

    const webSGUSerData = readFileSync('./assets/configure_amz_linux_sample_app.sh', 'utf-8');
    webServer.addUserData(webSGUSerData);

    cdk.Tags.of(webServer).add('application-name', 'python-web')
    cdk.Tags.of(webServer).add('stage', 'prod');

    new cdk.CfnOutput(this, "IP Address", {
      value: webServer.instancePublicIp,
    });

    const pipeline = new Pipeline(this, 'python_web_pipeline', {
      pipelineName: 'python-webApp',
      crossAccountKeys: false,
    });

    const sourceStage = pipeline.addStage({
      stageName: 'Source',
    });

    const buildStage = pipeline.addStage({
      stageName: 'Build',
    });

    const deployStage = pipeline.addStage({
      stageName: 'Deploy',
    });

    const sourceOutput = new Artifact();

    const githubSourceAction = new GitHubSourceAction({
      actionName: 'GithubSource',
      oauthToken: SecretValue.secretsManager('github-oauth-token'),
      owner: 'Dev-Squid',
      repo: 'sample-python-web-app',
      branch: 'main',
      output: sourceOutput,
    });

    sourceStage.addAction(githubSourceAction);

    const pythonTestProject = new PipelineProject(this, 'pythonTestProject', {
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_3
      }
    });

    const pythonTestOutput = new Artifact();

    const pythonTestAction = new CodeBuildAction({
      actionName: 'TestPython',
      project: pythonTestProject,
      input: sourceOutput,
      outputs: [pythonTestOutput]
    });

    // Deploy Actions
    const pythonDeployApplication = new ServerApplication(this, "python_deploy_application", {
      applicationName: 'python-webApp'
    });

    // Deployment group
    const pythonServerDeploymentGroup = new ServerDeploymentGroup(this, 'PythonAppDeployGroup', {
      application: pythonDeployApplication,
      deploymentGroupName: 'PythonAppDeploymentGroup',
      installAgent: true,
      ec2InstanceTags: new InstanceTagSet(
        {
          'application-name': ['python-web'],
          'stage': ['prod', 'stage']
        })
    });

    // Deployment action
    const pythonDeployAction = new CodeDeployServerDeployAction({
      actionName: 'PythonAppDeployment',
      input: sourceOutput,
      deploymentGroup: pythonServerDeploymentGroup,
    });

    deployStage.addAction(pythonDeployAction);
  }
}
