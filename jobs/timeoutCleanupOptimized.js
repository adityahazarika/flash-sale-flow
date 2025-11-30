/**
 * timeout-cleanup-optimized.js
 *
 * Usage:
 * - Configure environment variables (see below)
 * - Attach as Lambda and schedule via EventBridge every 2 minutes
 *
 * Behavior:
 * - Paginate Scan for orders where status = 1 (Pending) and createdAt < cutoff
 * - Process up to MAX_ORDERS_PER_RUN orders per invocation (safety limit)
 * - Process in batches of BATCH_SIZE and run batches with limited concurrency (PARALLEL_BATCHES)
 * - Each order processing will:
 *    - Update order status -> 4 (Rejected)
 *    - Restore inventory (quantity += qty, reserved -= qty) for each item
 * - Retries on transient Dynamo errors with exponential backoff
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";

// ---------- CONFIG (via env) ----------
const REGION = process.env.AWS_REGION || "ap-south-1";
const ORDERS_TABLE = process.env.ORDERS_TABLE || "orders";
const INVENTORY_TABLE = process.env.INVENTORY_TABLE || "inventory";
const ORDER_TIMEOUT_MINUTES = Number(process.env.ORDER_TIMEOUT_MINUTES ?? 2);

// Safety / performance tuning
const MAX_ORDERS_PER_RUN = Number(process.env.MAX_ORDERS_PER_RUN ?? 2000); // cap per Lambda run
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50); // orders per batch
const PARALLEL_BATCHES = Number(process.env.PARALLEL_BATCHES ?? 4); // concurrent batches
const INVENTORY_PARALLEL_PER_ORDER = Number(process.env.INVENTORY_PARALLEL_PER_ORDER ?? 5);

// Retry config
const MAX_UPDATE_RETRIES = Number(process.env.MAX_UPDATE_RETRIES ?? 4);
const BASE_RETRY_MS = Number(process.env.BASE_RETRY_MS ?? 150);

// ---------- SDK clients ----------
const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retryWithBackoff(fn, attempts = MAX_UPDATE_RETRIES, baseMs = BASE_RETRY_MS) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // retry only on transient errors or TransactionConflict / ProvisionedThroughputExceededException
      const code = err?.name || err?.code;
      const retriable = [
        "ProvisionedThroughputExceededException",
        "ThrottlingException",
        "InternalServerError",
        "TransactionConflict",
        "RequestLimitExceeded",
        "ResourceNotReadyException"
      ].includes(code) || (code && code.startsWith("5")); // any 5xx-ish name
      if (!retriable || i === attempts - 1) break;
      const wait = baseMs * Math.pow(2, i) + Math.floor(Math.random() * baseMs);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// perform single order cleanup: mark order rejected and restore inventory
async function processOrder(order) {
  // Minimal validation
  if (!order.orderId) {
    return { orderId: null, ok: false, reason: "missing-orderId" };
  }

  // 1) update order status -> 4 (rejected)
  const updateOrder = async () => {
    return docClient.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId: order.orderId },
      UpdateExpression: "SET #status = :rejected, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":rejected": 4,
        ":now": new Date().toISOString()
      }
    }));
  };

  try {
    await retryWithBackoff(updateOrder);
  } catch (err) {
    // if order update fails hard, return and log later
    return { orderId: order.orderId, ok: false, reason: "order-update-failed", err: String(err) };
  }

  // 2) Restore inventory for each item in order.items
  const items = Array.isArray(order.items) ? order.items : [];
  // chunk inventory restores for an order to avoid too many parallel updates
  const restorePromises = [];
  for (let i = 0; i < items.length; i += INVENTORY_PARALLEL_PER_ORDER) {
    const chunk = items.slice(i, i + INVENTORY_PARALLEL_PER_ORDER);
    const chunkPromises = chunk.map(item => {
      const restore = async () => {
        return docClient.send(new UpdateCommand({
          TableName: INVENTORY_TABLE,
          Key: { productId: item.productId },
          UpdateExpression: "SET quantity = if_not_exists(quantity, :zero) + :q, reserved = if_not_exists(reserved, :zero) - :q",
          ExpressionAttributeValues: {
            ":q": item.qty,
            ":zero": 0
          }
        }));
      };
      return retryWithBackoff(restore);
    });
    // wait for this small chunk to finish before next chunk (limits concurrency per order)
    restorePromises.push(Promise.allSettled(chunkPromises));
  }

  // execute sequential chunked groups
  for (const p of restorePromises) {
    await p;
  }

  return { orderId: order.orderId, ok: true };
}

// ---------- main handler ----------
export const handler = async (event) => {
  console.log(`🔔 Cleanup Lambda invoked at ${new Date().toISOString()} by: ${JSON.stringify(event?.source ?? event)}`);

  const now = new Date();
  const cutoffTime = new Date(now.getTime() - ORDER_TIMEOUT_MINUTES * 60000).toISOString();

  // Paginated scan with limit safety (we'll stop once we collected MAX_ORDERS_PER_RUN)
  const expiredOrders = [];
  let lastKey = undefined;
  try {
    do {
      const scanResp = await docClient.send(new ScanCommand({
        TableName: ORDERS_TABLE,
        // FilterExpression causes scan (no index). We only collect items to process, once we reach max we stop.
        FilterExpression: "#status = :pending AND createdAt < :cutoff",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pending": 1, ":cutoff": cutoffTime },
        ExclusiveStartKey: lastKey,
        // Optional: set a small Limit for each page to avoid eating too much time per page
        Limit: 1000
      }));

      const items = scanResp.Items || [];
      for (const it of items) {
        expiredOrders.push(it);
        if (expiredOrders.length >= MAX_ORDERS_PER_RUN) break;
      }

      lastKey = scanResp.LastEvaluatedKey;
      // stop scanning if we've reached cap
      if (expiredOrders.length >= MAX_ORDERS_PER_RUN) break;
    } while (lastKey);
  } catch (err) {
    console.error("❌ Scan failed:", err);
    return { statusCode: 500, body: "ScanFailed" };
  }

  console.log(`⏳ Collected ${expiredOrders.length} expired orders to process (cap=${MAX_ORDERS_PER_RUN})`);

  // Process in batches to control concurrency
  const batches = [];
  for (let i = 0; i < expiredOrders.length; i += BATCH_SIZE) {
    batches.push(expiredOrders.slice(i, i + BATCH_SIZE));
  }

  let processedCount = 0;
  let failedCount = 0;
  const batchResults = [];

  // process N batches at a time
  for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
    const chunk = batches.slice(i, i + PARALLEL_BATCHES);

    // map each batch to a Promise that processes its orders in parallel (bounded by BATCH_SIZE)
    const chunkPromises = chunk.map(async (batch) => {
      // process orders in parallel inside this batch
      const results = await Promise.allSettled(batch.map(order => processOrder(order)));
      // aggregate
      let ok = 0, fail = 0;
      results.forEach(r => {
        if (r.status === "fulfilled" && r.value && r.value.ok) ok++;
        else fail++;
      });
      return { ok, fail, batchSize: batch.length };
    });

    const settled = await Promise.all(chunkPromises);
    // record results
    for (const r of settled) {
      processedCount += r.ok + r.fail;
      failedCount += r.fail;
      batchResults.push(r);
    }

    // light throttle between parallel batch groups to give Dynamo breathing room
    await sleep(200); // 200ms
  }

  console.log(`✅ Cleanup summary: processed=${processedCount} failed=${failedCount} batches=${batchResults.length}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ processed: processedCount, failed: failedCount })
  };
};
