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
  }
}

provider "aws" {
  region = var.aws_region
  # Uses CLI credentials automatically
}

# Data sources
data "aws_caller_identity" "current" {}

# Automated Lambda packaging (cross-platform)
resource "null_resource" "lambda_package" {
  triggers = {
    # Trigger rebuild when source files change (only if they exist)
    lambda_source = fileexists("${path.module}/lambda/index.js") ? filemd5("${path.module}/lambda/index.js") : "missing"
    package_json  = fileexists("${path.module}/lambda/package.json") ? filemd5("${path.module}/lambda/package.json") : "missing"
    always_run    = timestamp() # Force run to create files if missing
  }

  provisioner "local-exec" {
    working_dir = path.module
    
    # Cross-platform commands to create lambda directory and files if missing
    command = <<-EOT
      ${local.is_windows ? "powershell -Command" : "/bin/bash -c"} "
        ${local.is_windows ? 
          "if (!(Test-Path lambda)) { New-Item -ItemType Directory -Path lambda }" :
          "mkdir -p lambda"
        }
      "
    EOT
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/lambda"
    
    # Cross-platform commands for packaging
    command = <<-EOT
      ${local.is_windows ? "powershell -Command" : "/bin/bash -c"} "
        ${local.is_windows ? "if (!(Test-Path node_modules)) { npm install }" : "[ ! -d node_modules ] && npm install || true"}
        ${local.is_windows ? 
          "Compress-Archive -Path index.js,package.json,node_modules -DestinationPath signaling-server.zip -Force" :
          "zip -r signaling-server.zip index.js package.json node_modules/"
        }
      "
    EOT
  }
}

# Local values for cross-platform detection
locals {
  is_windows = substr(pathexpand("~"), 0, 1) == "/" ? false : true
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

# Lambda function
resource "aws_lambda_function" "signaling_server" {
  filename         = "${path.module}/lambda/signaling-server.zip"
  function_name    = "${var.project_name}-${var.stage}"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  runtime         = "nodejs18.x"
  timeout         = var.lambda_timeout
  memory_size     = var.lambda_memory_size

  source_code_hash = fileexists("${path.module}/lambda/signaling-server.zip") ? filebase64sha256("${path.module}/lambda/signaling-server.zip") : null

  environment {
    variables = {
      STAGE = var.stage
      REGION = var.aws_region
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_basic,
    aws_cloudwatch_log_group.lambda_logs,
    null_resource.lambda_package,
  ]
}

# CloudWatch Log Group
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${var.project_name}-${var.stage}"
  retention_in_days = 14
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

# API Gateway v2 (WebSocket)
resource "aws_apigatewayv2_api" "websocket_api" {
  name                       = "${var.project_name}-websocket-${var.stage}"
  protocol_type             = "WEBSOCKET"
  route_selection_expression = "$request.body.action"

  # Note: CORS is not supported for WebSocket APIs
  # CORS handling for WebSocket must be done at the application level
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
  auto_deploy   = true

  default_route_settings {
    throttling_rate_limit  = 1000
    throttling_burst_limit = 2000
  }
}

# Outputs
output "websocket_url" {
  description = "WebSocket API Gateway URL"
  value       = "${aws_apigatewayv2_api.websocket_api.api_endpoint}/${var.stage}"
}

output "lambda_function_name" {
  description = "Lambda function name"
  value       = aws_lambda_function.signaling_server.function_name
}

output "api_gateway_id" {
  description = "API Gateway ID"
  value       = aws_apigatewayv2_api.websocket_api.id
}
