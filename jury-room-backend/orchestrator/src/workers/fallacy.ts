/**
 * Fallacy Worker
 * Subscribes to Message table
 * Analyzes for logical fallacies via Llama
 * Records alerts via recordFallacyAlert reducer
 */

import { getConnection, Message, DebateSession } from '../spacetime.js';
import { JURY_ROLE, toCanonicalRole } from '../constants.js';
import { callLlama } from '../utils/apis.js';
import { gateFallacyOutput } from '../utils/policy.js';
import { log, logSuccess, logError, writeAuditLog } from '../utils/logger.js';

const FALLACY_ANALYSIS_PROMPT = `You are a logical fallacy detector. Analyze the following argument and identify any logical fallacies.
Format your response as:
FALLACIES: [list fallacy types found, or "None"]
SEVERITY: [CRITICAL | HIGH | MEDIUM | LOW | NONE]
EXPLANATION: [brief explanation of issues found]

Argument to analyze:`;

export async function runFallacyWorker(intervalMs = 10000) {
  log('🔎', 'Fallacy Worker started');

  const processedMessages = new Set<string>();
  const alertedMessages = new Set<string>();
  let bootstrapped = false;

  while (true) {
    try {
      const conn = getConnection();

      // Seed dedupe set from persisted alerts so restarts don't recreate duplicates.
      const existingAlerts = conn.db.alert?.iter ? await conn.db.alert.iter() : [];
      for (const alert of existingAlerts as Array<{ messageId?: bigint | string }>) {
        if (alert.messageId === undefined || alert.messageId === null) {
          continue;
        }
        alertedMessages.add(alert.messageId.toString());
      }
      
      // Poll for new messages
      const allMessages = await conn.db.message.iter();

      if (!bootstrapped) {
        if ((allMessages as Message[]).length === 0) {
          log('🔎', 'Bootstrap waiting for message cache sync...');
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        for (const message of allMessages as Message[]) {
          processedMessages.add(message.id.toString());
        }

        bootstrapped = true;
        log('🔎', `Bootstrap complete: tracking ${processedMessages.size} existing messages, waiting for new ones`);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      
      for (const message of allMessages) {
        const msg = message as Message;
        const msgIdStr = msg.id.toString();
        
        // Skip if already processed
        if (processedMessages.has(msgIdStr)) continue;
        if (alertedMessages.has(msgIdStr)) {
          processedMessages.add(msgIdStr);
          continue;
        }
        
        // Skip if message is not from a debate agent
        const canonicalRole = toCanonicalRole(msg.role);
        const isDebateRole =
          canonicalRole === JURY_ROLE.PROSECUTION ||
          canonicalRole === JURY_ROLE.DEFENSE ||
          canonicalRole === JURY_ROLE.DEVILS_ADVOCATE;

        if (!isDebateRole) continue;

        processedMessages.add(msgIdStr);
        const alertRecorded = await analyzeFallacy(conn, msg);
        if (alertRecorded) {
          alertedMessages.add(msgIdStr);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (error) {
      logError('FALLACY', `${error}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function analyzeFallacy(conn: any, message: Message): Promise<boolean> {
  try {
    log('🔎', `Analyzing message ${message.id} for fallacies`);

    const prompt = `${FALLACY_ANALYSIS_PROMPT}\n\n"${message.content}"`;
    const analysisRaw = await callLlama(prompt);
    const policyCheck = gateFallacyOutput(analysisRaw);
    if (policyCheck.warnings.length > 0) {
      log('🛡️', `Fallacy output sanitized for message ${message.id}: ${policyCheck.warnings.join(', ')}`);
    }
    const analysis = policyCheck.sanitizedText;

    // Parse analysis
    const fallacyMatch = analysis.match(/FALLACIES:\s*(.+?)(?:\n|$)/i);
    const severityMatch = analysis.match(/SEVERITY:\s*(.+?)(?:\n|$)/i);
    const explanationMatch = analysis.match(/EXPLANATION:\s*(.+?)$/is);

    const fallacies = fallacyMatch?.[1]?.trim() || 'None';
    const severity = severityMatch?.[1]?.trim() || 'LOW';
    const explanation = explanationMatch?.[1]?.trim() || analysis;

    if (!/^none$/i.test(fallacies)) {
      // Record alert
      await conn.reducers.recordFallacyAlert({
        sessionId: message.sessionId,
        messageId: message.id,
        source: 'Llama-3.1',
        severity: severity.toUpperCase(),
        content: `${fallacies}\n\n${explanation}`,
      });

      logSuccess('🔎', `Fallacy alert recorded: ${severity}`);

      await writeAuditLog({
        worker: 'fallacy',
        messageId: message.id.toString(),
        sessionId: message.sessionId.toString(),
        fallacy: fallacies,
        severity,
        policyWarnings: policyCheck.warnings,
        policyReason: policyCheck.reason,
        status: 'alert_recorded',
      });
      return true;
    } else {
      logSuccess('🔎', `No fallacies detected in message ${message.id}`);
      return false;
    }
  } catch (error) {
    logError('FALLACY', `Failed to analyze message: ${error}`);
    return false;
  }
}
