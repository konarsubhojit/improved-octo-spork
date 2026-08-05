const functions = require('@google-cloud/functions-framework');
const { Logging } = require('@google-cloud/logging');

const logging = new Logging();
const log = logging.log('webhook-events');

functions.http('webhookReceiver', async (req, res) => {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const payload = req.body;
  console.log('Received Webhook Payload:', JSON.stringify(payload));

  // Write payload directly to Cloud Logging
  const entry = log.entry(
    { severity: 'INFO', resource: { type: 'global' } },
    { event: 'webhook_received', payload, timestamp: new Date().toISOString() }
  );

  try {
    await log.write(entry);
    return res.status(200).json({ status: 'success', message: 'Event logged' });
  } catch (err) {
    console.error('Failed to log event:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});
