terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

# Import existing resources that already exist in AWS
import {
  to = aws_dynamodb_table.connections
  id = "p2pmesh-signaling-connections-prod"
}

import {
  to = aws_cloudwatch_log_group.lambda_logs
  id = "/aws/lambda/p2pmesh-signaling-prod"
}

import {
  to = aws_iam_role.lambda_role
  id = "p2pmesh-signaling-lambda-role-prod"
}

import {
  to = aws_lambda_function.signaling_server
  id = "p2pmesh-signaling-prod"
}

import {
  to = aws_iam_role_policy.lambda_apigateway
  id = "p2pmesh-signaling-lambda-role-prod:p2pmesh-signaling-lambda-apigateway-policy-prod"
}

import {
  to = aws_iam_role_policy.lambda_dynamodb
  id = "p2pmesh-signaling-lambda-role-prod:p2pmesh-signaling-lambda-dynamodb-policy-prod"
}

import {
  to = aws_iam_role_policy_attachment.lambda_basic
  id = "p2pmesh-signaling-lambda-role-prod/arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

import {
  to = aws_lambda_permission.apigateway_lambda
  id = "p2pmesh-signaling-prod/AllowExecutionFromAPIGateway"
}

provider "aws" {
  region = var.aws_region
}

# Data sources
data "aws_caller_identity" "current" {}

# Local values for cross-platform detection
locals {
  is_windows = substr(pathexpand("~"), 0, 1) == "/" ? false : true
}

# Install Lambda dependencies
resource "null_resource" "lambda_dependencies" {
  triggers = {
    package_json = fileexists("${path.module}/lambda/package.json") ? filemd5("${path.module}/lambda/package.json") : "missing"
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/lambda"
    
    command = <<-EOT
      ${local.is_windows ? "powershell -Command" : "/bin/bash -c"} "
        ${local.is_windows ? "npm install --production" : "npm install --production"}
      "
    EOT
  }
}

# Create Lambda deployment package
data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = "${path.module}/lambda/signaling-server.zip"
  
  source_dir = "${path.module}/lambda"
  excludes = [
    "signaling-server.zip",
    ".gitkeep"
  ]
  
  depends_on = [null_resource.lambda_dependencies]
}

# Lambda function
resource "aws_lambda_function" "signaling_server" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "${var.project_name}-${var.stage}"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  runtime         = "nodejs18.x"
  timeout         = var.lambda_timeout
  memory_size     = var.lambda_memory_size

  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      STAGE             = var.stage
      REGION            = var.aws_region
      CONNECTIONS_TABLE = aws_dynamodb_table.connections.name
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_iam_role_policy.lambda_dynamodb,
    aws_cloudwatch_log_group.lambda_logs,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# DynamoDB table for connection state
resource "aws_dynamodb_table" "connections" {
  name           = "${var.project_name}-connections-${var.stage}"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "connectionId"

  attribute {
    name = "connectionId"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Name        = "${var.project_name}-connections-${var.stage}"
    Environment = var.stage
    Project     = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}

# S3 bucket for Lambda deployment package
resource "aws_s3_bucket" "lambda_deployments" {
  bucket = "${var.project_name}-lambda-deployments-${random_id.bucket_suffix.hex}"
}

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket_versioning" "lambda_deployments" {
  bucket = aws_s3_bucket.lambda_deployments.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "lambda_deployments" {
  bucket = aws_s3_bucket.lambda_deployments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${var.project_name}-${var.stage}"
  retention_in_days = 14

  lifecycle {
    create_before_destroy = true
  }
}

# IAM Role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "${var.project_name}-lambda-role-${var.stage}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  lifecycle {
    create_before_destroy = true
  }
}

# Basic Lambda execution policy
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  role       = aws_iam_role.lambda_role.name
}

# Additional policy for API Gateway management
resource "aws_iam_role_policy" "lambda_apigateway" {
  name = "${var.project_name}-lambda-apigateway-policy-${var.stage}"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "execute-api:ManageConnections"
        ]
        Resource = "arn:aws:execute-api:${var.aws_region}:${data.aws_caller_identity.current.account_id}:${aws_apigatewayv2_api.websocket_api.id}/*/*"
      }
    ]
  })
}

# Additional policy for DynamoDB access
resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "${var.project_name}-lambda-dynamodb-policy-${var.stage}"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
          "dynamodb:Query"
        ]
        Resource = aws_dynamodb_table.connections.arn
      }
    ]
  })
}

# API Gateway v2 (WebSocket)
resource "aws_apigatewayv2_api" "websocket_api" {
  name                       = "${var.project_name}-websocket-${var.stage}"
  protocol_type             = "WEBSOCKET"
  route_selection_expression = "$request.body.action"

  tags = {
    Name        = "${var.project_name}-websocket-${var.stage}"
    Environment = var.stage
    Project     = var.project_name
  }
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "apigateway_lambda" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.signaling_server.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.websocket_api.execution_arn}/*/*"
}

# WebSocket routes
resource "aws_apigatewayv2_route" "connect_route" {
  api_id    = aws_apigatewayv2_api.websocket_api.id
  route_key = "$connect"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "disconnect_route" {
  api_id    = aws_apigatewayv2_api.websocket_api.id
  route_key = "$disconnect"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "default_route" {
  api_id    = aws_apigatewayv2_api.websocket_api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

# Lambda integration
resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id           = aws_apigatewayv2_api.websocket_api.id
  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.signaling_server.invoke_arn
}

# API Gateway deployment
resource "aws_apigatewayv2_deployment" "websocket_deployment" {
  api_id = aws_apigatewayv2_api.websocket_api.id

  depends_on = [
    aws_apigatewayv2_route.connect_route,
    aws_apigatewayv2_route.disconnect_route,
    aws_apigatewayv2_route.default_route,
  ]

  lifecycle {
    create_before_destroy = true
  }
}

# API Gateway stage
resource "aws_apigatewayv2_stage" "websocket_stage" {
  api_id        = aws_apigatewayv2_api.websocket_api.id
  deployment_id = aws_apigatewayv2_deployment.websocket_deployment.id
  name          = var.stage
  auto_deploy   = false

  default_route_settings {
    throttling_rate_limit  = 1000
    throttling_burst_limit = 2000
  }
}

# Outputs
output "websocket_url" {
  description = "WebSocket API Gateway URL with WSS protocol"
  value       = "wss://${aws_apigatewayv2_api.websocket_api.id}.execute-api.${var.aws_region}.amazonaws.com/${var.stage}"
}

output "websocket_api_endpoint" {
  description = "API Gateway WebSocket endpoint (without protocol)"
  value       = "${aws_apigatewayv2_api.websocket_api.id}.execute-api.${var.aws_region}.amazonaws.com/${var.stage}"
}

output "api_gateway_info" {
  description = "API Gateway configuration details"
  value = {
    api_id = aws_apigatewayv2_api.websocket_api.id
    region = var.aws_region
    stage  = var.stage
    url    = "wss://${aws_apigatewayv2_api.websocket_api.id}.execute-api.${var.aws_region}.amazonaws.com/${var.stage}"
  }
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.signaling_server.function_name
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = aws_apigatewayv2_api.websocket_api.id
}

output "dynamodb_table_name" {
  description = "DynamoDB connections table name"
  value       = aws_dynamodb_table.connections.name
}

output "aws_region" {
  description = "AWS region used for deployment"
  value       = var.aws_region
}

output "project_name" {
  description = "Project name used for resource naming"
  value       = var.project_name
}

output "stage" {
  description = "Deployment stage"
  value       = var.stage
}

output "deployment_info" {
  description = "Complete deployment information"
  value = {
    websocket_url     = "wss://${aws_apigatewayv2_api.websocket_api.id}.execute-api.${var.aws_region}.amazonaws.com/${var.stage}"
    lambda_function   = aws_lambda_function.signaling_server.function_name
    dynamodb_table    = aws_dynamodb_table.connections.name
    region           = var.aws_region
    stage            = var.stage
    timestamp        = timestamp()
  }
}
