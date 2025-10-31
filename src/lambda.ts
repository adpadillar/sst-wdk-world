import type { SQSEvent, Context } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

import {
  SchedulerClient,
  CreateScheduleCommand,
} from "@aws-sdk/client-scheduler";

const schedulerClient = new SchedulerClient({});
const sqsClient = new SQSClient({});

async function handleRecord(
  record: SQSEvent["Records"][number],
  context: Context,
  opts: {
    workflowServerUrl: string;
    schedulerRoleArn: string;
    queueUrl: string;
  }
) {
  const queueName = record.attributes.MessageGroupId;
  console.log(
    `[world-sst] Invoked function ARN: ${context.invokedFunctionArn}`
  );

  if (!queueName) {
    console.error(`[world-sst] Missing queue name`, {
      record,
    });
    return;
  }

  const body = JSON.parse(record.body) as {
    message:
      | {
          runId: string;
          traceCarrier?: Record<string, string> | undefined;
        }
      | {
          workflowName: string;
          workflowRunId: string;
          workflowStartedAt: number;
          stepId: string;
          traceCarrier?: Record<string, string> | undefined;
        };
    webhookUri: string;
    currentRetries?: number;
  };

  const { message, webhookUri, currentRetries } = body;

  const url = new URL(webhookUri, opts.workflowServerUrl);
  console.log(`[world-sst] Sending webhook to ${url}`);

  const attempt = currentRetries
    ? currentRetries + 1
    : Number(record.attributes.ApproximateReceiveCount ?? 1);

  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(message),
    headers: {
      "Content-Type": "application/json",
      "x-vqs-queue-name": queueName,
      "x-vqs-message-id": record.messageId,
      "x-vqs-message-attempt": String(attempt),
    },
  });

  if (response.ok) {
    return;
  }

  const text = await response.text();

  if (response.status === 503) {
    if (attempt >= 3) {
      console.error(`[world-sst] Reached max retries of 3`, {
        queueName,
        messageId: record.messageId,
        attempt,
      });
      return;
    }

    const retryInMs = Number(JSON.parse(text).retryIn) * 1000;

    if (retryInMs < 15 * 60 * 1000) {
      // we want to use the queue delay seconds instead of event scheduler
      console.log(`[world-sst] Using queue delay seconds`, {
        retryInMs,
      });
      const command = new SendMessageCommand({
        QueueUrl: opts.queueUrl,
        MessageBody: record.body,
        DelaySeconds: retryInMs / 1000,
        MessageGroupId: queueName,
      });
      await sqsClient.send(command);
      return;
    }

    console.log(`[world-sst] Using event scheduler`, {
      retryInMs,
    });
    // if the retry is greater than 15 minutes, we use event scheduler
    // this is because event scheduler has granularity of up to 1 minute,
    // not individual seconds
    const scheduledDate = new Date(Date.now() + retryInMs);
    const scheduledDateString = scheduledDate.toISOString().substring(0, 19);

    console.log(
      `[world-sst] Scheduling retry for ${record.messageId} in ${retryInMs}ms`,
      { scheduledDateString }
    );

    const command = new CreateScheduleCommand({
      Name: `retry-${record.messageId}`,
      ScheduleExpression: `at(${scheduledDateString})`,
      ScheduleExpressionTimezone: "UTC",
      ActionAfterCompletion: "DELETE",
      FlexibleTimeWindow: {
        Mode: "OFF",
      },
      Target: {
        Arn: context.invokedFunctionArn,
        RoleArn: opts.schedulerRoleArn,
        Input: JSON.stringify({
          Records: [record],
        }),
      },
    });

    await schedulerClient.send(command);
  }

  console.error(`[world-sst] Failed to queue message`, {
    queueName,
    text,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: body.toString(),
  });
}

export async function handler(
  event: SQSEvent,
  context: Context,
  opts: {
    queueUrl: string;
    schedulerRoleArn: string;
    workflowServerUrl: string;
  }
) {
  console.log("[world-sst-lambda] handling event", { event });
  for (const record of event.Records) {
    await handleRecord(record, context, {
      queueUrl: opts.queueUrl,
      schedulerRoleArn: opts.schedulerRoleArn,
      workflowServerUrl: opts.workflowServerUrl,
    });
  }
}

export async function createLambdaHandler(opts: {
  queueUrl: string;
  schedulerRoleArn: string;
  workflowServerUrl: string;
}) {
  return async (event: SQSEvent, context: Context) => {
    await handler(event, context, opts);
  };
}
