# sst-wdk-world

A TypeScript library that provides an embedded implementation of the Workflow Development Kit (WDK) "World" interface, enabling seamless integration with AWS services for workflow orchestration and queue-based message processing.

## Overview

`sst-wdk-world` implements the `@workflow/world` interface using AWS services, allowing developers to build and deploy distributed workflows with built-in support for queueing, storage, and event streaming. This package is designed to work in both Lambda and local development environments.

## Key Features

- **Queue Management**: Integration with AWS SQS for reliable message queuing and processing
- **Persistent Storage**: DynamoDB-backed storage for workflow state and execution data
- **Event Streaming**: File-based streaming capabilities for event processing
- **Lambda Support**: Dedicated Lambda handler for processing SQS messages with automatic retry logic
- **Configuration Management**: Environment-based configuration with sensible defaults
- **AWS SDK Integration**: Built-in support for S3, DynamoDB, SQS, and EventBridge Scheduler

## Installation

```bash
npm install sst-wdk-world
# or
pnpm add sst-wdk-world
```

## Usage

### Creating a World Instance

```typescript
import { createWorld } from "sst-wdk-world";

const world = await createWorld();
```

The `createWorld()` function initializes an embedded world instance that combines:
- **Queue**: SQS-backed message queue for workflow events
- **Storage**: DynamoDB-backed persistent storage for workflow state
- **Streamer**: File-based event streaming capabilities

### Environment Configuration

The library requires the following environment variables:

- `WORKFLOW_SQS_QUEUE_URL` - The SQS queue URL for workflow messages (required)
- `WORKFLOW_TABLE_NAME` - The DynamoDB table name for state storage (required)
- `WORKFLOW_EMBEDDED_DATA_DIR` - Directory for local data storage (defaults to `.workflow-data`)
- `PORT` - Port for local services (defaults to `3000`)

### Lambda Handler

For processing workflow messages in Lambda:

```typescript
import { createLambdaHandler } from "sst-wdk-world";

export const handler = createLambdaHandler({
  queueUrl: process.env.WORKFLOW_SQS_QUEUE_URL!,
  schedulerRoleArn: process.env.SCHEDULER_ROLE_ARN!,
  workflowServerUrl: process.env.WORKFLOW_SERVER_URL!,
});
```

The Lambda handler:
- Processes SQS messages containing workflow events
- Sends webhooks to the workflow server
- Implements exponential retry logic with a maximum of 3 retries
- Uses AWS EventBridge Scheduler for delays greater than 15 minutes
- Uses SQS delay seconds for shorter retry periods

## Core Modules

### Queue (`src/queue.ts`)

Provides SQS-backed queue implementation:
- `queue()` - Queue workflow messages to SQS
- `createQueueHandler()` - Create HTTP handlers for queue message processing
- `getDeploymentId()` - Get the deployment identifier

### Storage (`src/storage.ts`)

DynamoDB-backed storage for workflow state:
- State persistence and retrieval
- Integration with `@workflow/world-local` for local operations
- Support for batch operations

### Streamer (`src/streamer.ts`)

File-based event streaming:
- Stream workflow events to local files
- Support for event tracking and replay

### Lambda (`src/lambda.ts`)

AWS Lambda event handlers:
- Process SQS records containing workflow messages
- Handle retry logic and error cases
- Support for workflow server webhooks

## Architecture

The library implements the `@workflow/world` interface, providing a complete "world" object that combines all necessary functionality for workflow execution:

```
createWorld()
├── Queue (SQS)
│   ├── Message queuing
│   └── Message handling
├── Storage (DynamoDB)
│   └── State persistence
└── Streamer (File-based)
    └── Event streaming
```

## Dependencies

### Runtime
- `@aws-sdk/*` - AWS SDK clients for SQS, DynamoDB, S3, and Scheduler
- `@workflow/world` - WDK world interface
- `@workflow/world-local` - Local world implementation
- `zod` - Runtime data validation
- `ulid` - Unique ID generation

### Development
- `typescript` - TypeScript compiler
- `@types/aws-lambda` - AWS Lambda type definitions
- `@types/node` - Node.js type definitions
- `tsup` - TypeScript bundler
- `@changesets/cli` - Changelog management

## Publishing

The package uses Changesets for versioning and publishing:

```bash
pnpm run release
```

This command:
1. Builds the TypeScript code
2. Publishes the package using Changesets
3. Updates the changelog and version

## Development

Build the project:

```bash
pnpm run build
```

Run CI checks:

```bash
pnpm run ci
```

## License

MIT - Created by Axel Padilla

## Related Packages

- `@workflow/world` - WDK world interface specification
- `@workflow/world-local` - Local development implementation
- `@workflow/errors` - Workflow error definitions
