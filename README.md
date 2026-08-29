# Trial Expiry Reminder

A zero-cost, fully serverless application that reminds you before a free trial turns into a paid
subscription. It runs entirely inside the **AWS Always Free Tier**:

- **Amazon DynamoDB** (On-Demand) stores the reminders.
- **AWS Lambda** (Node.js 20.x, ESM) exposes a REST API through a **Lambda Function URL**.
- **Amazon EventBridge** triggers a daily Lambda at **09:00 UTC** that emails the reminders due today
  through **Gmail SMTP** (Nodemailer).
- A single-file **HTML/Vanilla JS** dashboard (`public/index.html`) creates, lists and deletes reminders.

## Architecture

```text
public/index.html ──HTTPS──▶ ApiFunction (Lambda Function URL) ──▶ DynamoDB (RemindersTable)
                                                                        ▲
EventBridge cron(0 9 * * ? *) ──▶ DailyNotifierFunction ──Gmail SMTP──▶ │ status: PENDING → SENT
```

### Data model (`RemindersTable`)

| Attribute       | Type   | Notes                                          |
| --------------- | ------ | ---------------------------------------------- |
| `reminder_date` | String | Partition key, `YYYY-MM-DD` (the day to email) |
| `reminder_id`   | String | Sort key, UUID v4                              |
| `serviceName`   | String | Trial/service name                             |
| `expiryDate`    | String | `YYYY-MM-DD` trial expiry date                 |
| `customNote`    | String | Optional note shown in the email               |
| `userEmail`     | String | Recipient                                      |
| `status`        | String | `PENDING` or `SENT`                            |
| `createdAt`     | String | ISO timestamp                                  |
| `sentAt`        | String | ISO timestamp, set when the email is delivered |

`StatusIndex` (GSI) uses `status` as the partition key and `reminder_date` as the sort key, so both the
"list pending reminders" API call and the daily job are single, cheap `Query` operations.

## Project structure

```text
├── template.yaml            # AWS SAM template (DynamoDB, Lambdas, Function URL, schedule, IAM)
├── package.json             # Runtime dependencies and tests
├── src/
│   ├── handlers/
│   │   ├── api.mjs          # CRUD routes behind the Lambda Function URL
│   │   └── notifier.mjs     # Daily cron processor & Gmail SMTP dispatcher
│   └── utils/
│       ├── db.mjs           # DynamoDB DocumentClient helper
│       └── mailer.mjs       # Nodemailer transport & HTML template generator
├── public/index.html        # Static dashboard
└── tests/                   # node:test unit tests
```

## API

Base URL = the `ApiFunctionUrl` stack output.

### `POST /reminders`

```json
{
  "serviceName": "Netflix",
  "expiryDate": "2026-03-10",
  "userEmail": "you@example.com",
  "customNote": "Cancel from the billing page",
  "reminderOffsets": [3, 1, 0]
}
```

- `reminderOffsets` (optional) — days *before* `expiryDate` to send a reminder. Defaults to
  `[3, 1, 0]` (3 days before, 1 day before, and on the expiry day).
- `reminderDates` (optional) — explicit `YYYY-MM-DD` dates instead of offsets.
- One DynamoDB item is created per reminder date. Responds `201` with the created items.

### `GET /reminders`

Returns every `PENDING` reminder, sorted by reminder date:

```json
{ "count": 3, "reminders": [ { "reminder_date": "2026-03-07", "reminder_id": "…", "…": "…" } ] }
```

### `DELETE /reminders/{reminder_date}/{reminder_id}`

Cancels a single reminder. Responds `404` when it does not exist.

## Prerequisites

- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS credentials with permission to deploy CloudFormation stacks (`aws configure`)
- Node.js 20+
- A Gmail account with 2-Step Verification enabled

## Generating a Google App Password

Gmail rejects your normal account password over SMTP; you need a 16-character App Password:

1. Open <https://myaccount.google.com/security> and enable **2-Step Verification**.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Enter an app name such as `Trial Expiry Reminder` and click **Create**.
4. Copy the generated 16-character password (spaces can be removed) — this is `GMAIL_APP_PASSWORD`.
5. Your Gmail address is `GMAIL_USER`.

Google's free SMTP relay allows roughly 500 messages per day, which is far more than this app needs.

## Build & deploy

```bash
npm install          # optional, only needed to run the unit tests locally
sam build
sam deploy --guided
```

During `sam deploy --guided` you will be asked for:

| Parameter          | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| `GmailUser`        | `you@gmail.com`                                                 |
| `GmailAppPassword` | The 16-character App Password (stored with `NoEcho`)            |
| `CorsAllowOrigin`  | `*`, or the origin that hosts `public/index.html`               |

Answer **yes** to *"ApiFunction Function Url may not have authorization defined, Is this okay?"* — the
Function URL is intentionally public so the static dashboard can call it.

Subsequent deployments only need:

```bash
sam build && sam deploy
```

To update the Gmail credentials later:

```bash
sam deploy --parameter-overrides GmailUser=you@gmail.com GmailAppPassword=xxxxxxxxxxxxxxxx
```

## Using the dashboard

1. Copy the `ApiFunctionUrl` value printed in the stack outputs.
2. Open `public/index.html` in your browser (or host it on S3/GitHub Pages).
3. Paste the Function URL into the **Lambda Function URL** field — it is remembered in `localStorage`.
4. Create, list and delete reminders.

## Testing the notifier manually

```bash
sam local invoke DailyNotifierFunction --env-vars env.json   # local run
aws lambda invoke --function-name <DailyNotifierFunction-name> /dev/stdout   # deployed run
```

`env.json` for local runs:

```json
{ "DailyNotifierFunction": { "TABLE_NAME": "<table>", "GMAIL_USER": "you@gmail.com", "GMAIL_APP_PASSWORD": "xxxx" } }
```

## Unit tests

```bash
npm install
npm test
```

The tests cover date maths, input validation and the HTML email rendering (including escaping of
user-supplied notes); they do not require AWS credentials.

## Cost

| Service     | Free tier                          | Typical usage    |
| ----------- | ---------------------------------- | ---------------- |
| Lambda      | 1M requests + 400k GB-s per month  | ~30 invocations  |
| DynamoDB    | 25 GB storage, On-Demand           | a few KB         |
| EventBridge | Scheduled rules are free           | 1 rule           |
| Gmail SMTP  | Free                               | a few emails/day |
