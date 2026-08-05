const functions = require('@google-cloud/functions-framework');
const { Logging } = require('@google-cloud/logging');
const crypto = require('crypto');

const logging = new Logging();
const log = logging.log('vercel-drains');

functions.http('vercelLogDrain', async (req, res) => {
  // 1. Handle Vercel Endpoint Verification
  // When verifying the drain, Vercel sends an 'x-vercel-verify' header
  const verifyHeader = req.headers['x-vercel-verify'];
  if (verifyHeader) {
    res.setHeader('x-vercel-verify', verifyHeader);
  }

  // 2. Validate Signature (Optional but recommended)
  // Set VERCEL_DRAIN_SECRET in Cloud Function environment variables if used
  const signatureSecret = process.env.VERCEL_DRAIN_SECRET;
  if (signatureSecret) {
    const rawBody = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha1', signatureSecret)
      .update(rawBody)
      .digest('hex');

    const receivedSignature = req.headers['x-vercel-signature'];
    if (receivedSignature !== expectedSignature) {
      console.warn('Invalid Vercel signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  // 3. Process Log Entries
  const logs = Array.isArray(req.body) ? req.body : [req.body];

  try {
    const entries = logs.map((item) => {
      // Map Vercel levels (info, warning, error, fatal) to GCP severities
      let severity = 'INFO';
      if (item.level === 'error' || item.level === 'fatal') severity = 'ERROR';
      else if (item.level === 'warning') severity = 'WARNING';

      const metadata = {
        severity,
        timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
        resource: {
          type: 'global',
        },
        labels: {
          vercel_project_id: item.projectId || 'unknown',
          vercel_source: item.source || 'unknown',
          vercel_environment: item.environment || 'production',
        },
      };

      return log.entry(metadata, {
        message: item.message || JSON.stringify(item),
        vercelData: item,
      });
    });

    // Batch write to Cloud Logging
    await log.write(entries);
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error writing logs to Cloud Logging:', err);
    return res.status(500).send('Internal Server Error');
  }
});
