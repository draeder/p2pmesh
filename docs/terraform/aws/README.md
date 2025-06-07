# AWS Terraform Deployment for P2P Mesh Signaling Server

This directory contains Terraform infrastructure code to deploy the P2P Mesh signaling server to AWS using Lambda and API Gateway WebSocket.

## Architecture Overview

The AWS deployment creates the following infrastructure:

- **AWS Lambda Function**: Runs the signaling server logic
- **API Gateway WebSocket API**: Provides WebSocket endpoints for client connections
- **IAM Roles & Policies**: Manages permissions for Lambda and API Gateway
- **CloudWatch Log Groups**: Collects and stores application logs
- **S3 Bucket**: Stores Lambda deployment packages (optional, for versioning)

## Prerequisites

1. **AWS CLI**: Install and configure with your credentials
   ```bash
   aws configure
   ```

2. **Terraform**: Install Terraform v1.0 or later
   
   **Windows**:
   ```powershell
   # Using Chocolatey
   choco install terraform
   
   # Or download from https://www.terraform.io/downloads.html
   ```
   
   **macOS**:
   ```bash
   brew install terraform
   ```
   
   **Ubuntu/Debian**:
   ```bash
   sudo apt-get install terraform
   ```

3. **Node.js**: Required for Lambda function packaging
   
   **Windows**: Download from https://nodejs.org/
   
   **macOS**:
   ```bash
   # Install Node.js 18.x (Lambda runtime)
   nvm install 18
   nvm use 18
   ```
   
   **Ubuntu/Debian**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

## File Structure

Before running Terraform, ensure you have the required Lambda files in place:

```
terraform/aws/
├── main.tf
├── variables.tf
├── deploy.bat (auto-generated on Windows)
├── deploy.ps1 (auto-generated on Windows)
└── lambda/
    ├── index.js (required)
    ├── package.json (required)
    └── .gitkeep
```

**Important**: Make sure the `lambda/index.js` and `lambda/package.json` files exist before running `terraform plan` or `terraform apply`. These files should be created as part of the infrastructure setup.

## Quick Start

1. **Navigate to the AWS Terraform directory**:
   ```bash
   cd terraform/aws
   ```

2. **Ensure Lambda files exist** (Terraform will create the lambda directory if needed):
   ```bash
   # Check if lambda files exist
   ls lambda/
   
   # If missing, they should be created from the provided templates
   ```

3. **Deploy with Terraform** (cross-platform):
   ```bash
   # Initialize and deploy (works on Windows, macOS, Linux)
   terraform init
   terraform apply
   ```

   **Windows users can also use**:
   ```cmd
   # Using batch file (will be created during deployment)
   deploy.bat
   
   # Or using PowerShell (will be created during deployment)
   powershell -ExecutionPolicy Bypass -File deploy.ps1
   ```

4. **Get the WebSocket URL**:
   ```bash
   terraform output websocket_url
   ```

## Manual Deployment

The deployment process is now fully automated through Terraform. The Lambda function packaging happens automatically when you run `terraform apply`.

### 1. Package the Lambda Function

**Automatic (Recommended)**: Terraform handles packaging automatically using cross-platform commands.

**Manual (if needed)**:

**Windows (PowerShell)**:
```powershell
cd terraform/aws/lambda
npm install
Compress-Archive -Path index.js,package.json,node_modules -DestinationPath signaling-server.zip -Force
cd ..
```

**macOS/Linux**:
```bash
cd terraform/aws/lambda
npm install
zip -r signaling-server.zip index.js package.json node_modules/
cd ..
```

### 2. Initialize Terraform

```bash
terraform init
```

### 3. Plan the Deployment

```bash
terraform plan
```

### 4. Apply the Configuration

```bash
terraform apply
```

## Configuration Options

You can customize the deployment using Terraform variables:

### Command Line Variables

```bash
# Deploy to a different region
terraform apply -var="aws_region=us-west-2"

# Use a custom project name
terraform apply -var="project_name=my-signaling-server"

# Deploy to staging environment
terraform apply -var="stage=staging"

# Adjust Lambda resources
terraform apply -var="lambda_memory_size=1024" -var="lambda_timeout=60"
```

### Variables File

Create a `terraform.tfvars` file:

```hcl
aws_region = "us-west-2"
project_name = "my-p2p-mesh"
stage = "prod"
lambda_memory_size = 1024
lambda_timeout = 60
```

Then apply:
```bash
terraform apply
```

### Available Variables

| Variable | Description | Default | Valid Values |
|----------|-------------|---------|--------------|
| `aws_region` | AWS region for deployment | `us-east-1` | Any valid AWS region |
| `project_name` | Project name for resource naming | `p2pmesh-signaling` | Lowercase letters, numbers, hyphens |
| `stage` | Deployment stage | `prod` | `dev`, `staging`, `prod` |
| `lambda_timeout` | Lambda timeout in seconds | `30` | `1-900` |
| `lambda_memory_size` | Lambda memory in MB | `512` | `128-10240` |

## Using the AWS Transport

Once deployed, use the AWS-specific transport in your client code:

```javascript
import { createMesh } from '../src/index.js';

// Get your WebSocket URL from Terraform output
const websocketUrl = 'wss://your-api-id.execute-api.us-east-1.amazonaws.com/prod';

// Use with named transport (recommended)
const mesh = await createMesh({
  transportName: 'aws-websocket',
  transportOptions: {
    url: websocketUrl,
    stage: 'prod',
    region: 'us-east-1',
    heartbeatInterval: 30000
  }
});

await mesh.join();
```

## Monitoring and Debugging

### CloudWatch Logs

View Lambda function logs:
```bash
aws logs describe-log-groups --log-group-name-prefix="/aws/lambda/p2pmesh-signaling"
aws logs tail /aws/lambda/p2pmesh-signaling-prod --follow
```

### API Gateway Metrics

Monitor WebSocket connections and messages through AWS Console:
1. Go to API Gateway → Your WebSocket API → Monitoring
2. View metrics for:
   - Connection count
   - Message count
   - Integration latency
   - Errors

## Testing the Deployment

### Using the Browser Example

1. **Get the WebSocket URL**:
   ```bash
   terraform output websocket_url
   ```

2. **Open the browser example**:
   ```bash
   # From the project root
   cd examples/browser
   
   # Serve the files (using Python's built-in server)
   python3 -m http.server 8000
   
   # Or using Node.js
   npx http-server .
   ```

3. **Configure the example**:
   - Open http://localhost:8000 in your browser
   - Select "AWS Lambda" from the deployment dropdown
   - Paste your WebSocket URL from step 1
   - Generate or enter a peer ID
   - Click "Start P2P Mesh"

4. **Test with multiple peers**:
   - Open multiple browser tabs/windows
   - Use different peer IDs in each
   - Watch the peer list update as connections are established
   - Send test messages between peers

### Command Line Testing

Test WebSocket connectivity:

**Windows (PowerShell)**:
```powershell
# Install wscat if not already installed
npm install -g wscat

# Test connection
wscat -c wss://your-api-id.execute-api.us-east-1.amazonaws.com/prod

# Send a test message
{"type": "join", "peerId": "test-peer-123"}
```

**macOS/Linux**:
```bash
# Using wscat (install with: npm install -g wscat)
wscat -c wss://your-api-id.execute-api.us-east-1.amazonaws.com/prod

# Send a test message
{"type": "join", "peerId": "test-peer-123"}
```

### Expected Behavior

When testing with the browser example:

1. **Connection**: Browser connects to AWS API Gateway WebSocket
2. **Bootstrap**: New peers receive a list of existing peers
3. **WebRTC**: Direct peer-to-peer connections are established
4. **Messaging**: Messages can be sent directly between browsers
5. **Cleanup**: Disconnected peers are automatically removed

## Troubleshooting

### Common Issues

1. **"AccessDenied" errors**:
   - Ensure AWS CLI is configured: `aws sts get-caller-identity`
   - Check IAM permissions for Lambda, API Gateway, and CloudWatch

2. **Lambda timeout errors**:
   - Increase `lambda_timeout` variable
   - Check CloudWatch logs for specific errors

3. **WebSocket connection failures**:
   - Verify the WebSocket URL format
   - Check CORS configuration in API Gateway
   - Ensure Lambda function is properly deployed

4. **"Peer not found" errors**:
   - Connection state may not be synchronized
   - Check Lambda logs for connection handling

5. **"no such file or directory" for lambda files**:
   - Ensure `lambda/index.js` and `lambda/package.json` exist
   - Terraform will attempt to create the lambda directory automatically
   - Check that you're in the correct directory (`terraform/aws`)

### Debug Commands

**Cross-platform**:
```bash
# Check Terraform state
terraform show

# Get all outputs
terraform output

# Validate configuration
terraform validate
```

**AWS CLI commands**:
```bash
# Check Lambda function
aws lambda get-function --function-name p2pmesh-signaling-prod

# Check API Gateway
aws apigatewayv2 get-apis
```

## Scaling Considerations

### Performance Limits

- **API Gateway WebSocket**: 1,000 concurrent connections per API by default
- **Lambda Concurrency**: 1,000 concurrent executions per region by default
- **Connection Duration**: API Gateway WebSocket connections timeout after 2 hours of inactivity

### Scaling Solutions

1. **Increase API Gateway Limits**: Request limit increases through AWS Support

2. **Multiple Regions**: Deploy to multiple regions for geographic distribution

3. **Connection Pooling**: Implement connection pooling in the Lambda function

4. **External State Storage**: Use DynamoDB for connection state instead of in-memory storage

## Security

### Network Security

- All traffic encrypted with TLS/WSS
- API Gateway provides DDoS protection
- VPC deployment optional (configure in `main.tf`)

### Access Control

- IAM-based access control for AWS resources
- **Note**: WebSocket APIs don't support traditional CORS headers
- Origin validation can be implemented at the Lambda function level
- No hardcoded credentials (uses AWS CLI/IAM roles)

### Production Hardening

For production deployments, consider implementing origin validation in the Lambda function:

```javascript
// Add to lambda/index.js for origin validation
case '$connect':
  const origin = event.headers?.Origin || event.headers?.origin;
  const allowedOrigins = [
    'https://yourdomain.com',
    'https://app.yourdomain.com'
  ];
  
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
    console.log(`Rejected connection from unauthorized origin: ${origin}`);
    return { statusCode: 403 };
  }
  
  console.log(`Client ${connectionId} connected from ${origin}`);
  return { statusCode: 200 };
```

**Note**: Unlike HTTP APIs, WebSocket APIs in API Gateway v2 don't support CORS configuration. Origin validation and security must be handled at the application (Lambda) level.

## Cost Optimization

### Cost Components

- **API Gateway**: $1.00 per million messages + $0.25 per million connection minutes
- **Lambda**: $0.20 per 1M requests + $0.0000166667 per GB-second
- **CloudWatch Logs**: $0.50 per GB ingested

### Cost Reduction Tips

1. **Optimize Lambda Memory**: Start with 512MB, adjust based on performance
2. **Log Retention**: Set appropriate CloudWatch log retention periods
3. **Connection Management**: Implement proper connection cleanup
4. **Batch Operations**: Use batched signaling when possible

## Cleanup

To destroy all created resources:

```bash
terraform destroy
```

Or use the specific resources:
```bash
terraform destroy -target=aws_lambda_function.signaling_server
```

## Support

For issues related to:

- **Terraform**: Check [Terraform AWS Provider docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- **AWS Lambda**: Check [AWS Lambda documentation](https://docs.aws.amazon.com/lambda/)
- **API Gateway WebSocket**: Check [API Gateway WebSocket docs](https://docs.aws.amazon.com/apigateway/latest/developerguide/websocket-api.html)
- **P2P Mesh Library**: See main project documentation

## Contributing

When modifying the AWS deployment:

1. Test changes in a development environment first
2. Update this README with any new variables or configuration options
3. Ensure backward compatibility with existing deployments
4. Add appropriate validation for new variables
