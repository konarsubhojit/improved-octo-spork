# improved-octo-spork

A 2nd Gen Google Cloud Function (Node.js) that acts as a webhook receiver for Vercel Log Drains. It receives batched log events from Vercel, handles verification headers, and writes them into Google Cloud Logging using the official `@google-cloud/logging` SDK.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VERCEL_DRAIN_SECRET` | Optional (recommended) | A shared secret string used to verify the HMAC-SHA1 signature (`x-vercel-signature` header) on incoming requests from Vercel. If not set, signature validation is skipped. Set this to the same value as the **Custom Secret** configured in your Vercel Log Drain settings. Example: `my_secret_key_123` |

### Setting Environment Variables

#### During deployment (gcloud CLI)

```bash
gcloud functions deploy vercel-log-drain \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=vercelLogDrain \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars VERCEL_DRAIN_SECRET=my_secret_key_123
```

#### After deployment (gcloud CLI)

```bash
gcloud functions deploy vercel-log-drain \
  --gen2 \
  --region=us-central1 \
  --update-env-vars VERCEL_DRAIN_SECRET=my_secret_key_123
```

#### Via GCP Console

1. Open **GCP Console** > **Cloud Functions** > select your function.
2. Click **Edit**.
3. Expand **Runtime, build, connections and security settings**.
4. Under **Runtime environment variables**, click **Add variable**.
5. Set **Name** to `VERCEL_DRAIN_SECRET` and **Value** to your secret string.
6. Click **Deploy**.

## Deployment

```bash
gcloud functions deploy vercel-log-drain \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=vercelLogDrain \
  --trigger-http \
  --allow-unauthenticated
```

## Vercel Log Drain Configuration

1. Go to **Vercel Dashboard** > **Settings** (or Team Settings) > **Log Drains**.
2. Click **Add Log Drain** > **Custom Endpoint**.
3. **URL Endpoint**: Paste your Cloud Function Trigger URL.
4. **Delivery Format**: Choose `JSON`.
5. **Custom Secret** (Optional): Enter a secure random string — set the same value as `VERCEL_DRAIN_SECRET` in your Cloud Function.
6. Click **Save**.

## Viewing Logs

Open **GCP Console** > **Logging** > **Logs Explorer** and filter by log name `vercel-drains`.