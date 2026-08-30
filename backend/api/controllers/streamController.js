/**
 * Stream Controller
 *
 * REST endpoints for payment stream data. Read endpoints are cached at the
 * route level. The /accrued endpoint queries the contract live (not cached).
 *
 * Error handling: handlers report a *specific* failure reason to the caller
 * (rather than a generic "Internal error") while never leaking sensitive
 * material (Stellar secret keys, API keys, auth tokens, RPC URLs, etc.).
 * Full error detail is only written to the server-side log.
 */

import prisma from '../../lib/prisma.js';
import { logControllerError } from '../../config/logger.js';
import { xdr, scValToNative } from '@stellar/stellar-sdk';

const STREAMING_CONTRACT_ID = process.env.STREAMING_CONTRACT_ID || '';

// Patterns that must never leak into a client-facing error message.
const SENSITIVE_PATTERNS = [
  /S[A-Z2-7]{55}/g, // Stellar ed25519 secret seed (starts with S, 56 chars)
  /sk_(live|test)_[A-Za-z0-9]+/g, // Stripe secret keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\b[A-Z0-9]{20,}\b/g, // generic API keys / tokens
  /(authorization|bearer|token|api[_-]?key)[=: ]+["']?[A-Za-z0-9._-]+/gi,
  /https?:\/\/[^\s"']+/g, // URLs (may embed RPC / Horizon / API endpoints)
];
const SECRET_REDACT = '[REDACTED]';

/**
 * Produce a caller-safe failure reason from an Error.
 *
 * Returns the (sanitized) specific error message when one is available,
 * otherwise falls back to a contextual default. Never returns null/empty so
 * callers always receive a meaningful reason.
 */
function safeErrorMessage(err, fallback) {
  const raw =
    typeof err === 'string'
      ? err
      : err && typeof err.message === 'string'
        ? err.message
        : '';
  let msg = raw;
  for (const re of SENSITIVE_PATTERNS) {
    msg = msg.replace(re, SECRET_REDACT);
  }
  msg = msg.trim().replace(/\s+/g, ' ');
  return msg.length ? msg : fallback;
}

/**
 * Standardized 500 response for stream operations.
 *
 * Logs the full error server-side (via the request) and returns a non-generic
 * message that identifies the failing operation + a sanitized reason.
 */
function sendStreamError(req, res, err, operation, fallback) {
  if (typeof logControllerError === 'function' && err && req) {
    logControllerError(`stream.${operation}`, err, req);
  }
  const reason = safeErrorMessage(err, fallback);
  return res.status(500).json({ error: `Failed to ${operation}: ${reason}` });
}

// Prisma rows carry BigInt for streamId; JSON.stringify can't serialize BigInt
// natively, so stringify it explicitly before sending, matching the pattern
// used elsewhere in this codebase (see escrowController.js).
function serializeStream(stream) {
  if (!stream) return stream;
  return { ...stream, streamId: stream.streamId?.toString() };
}

// ── Read handlers ─────────────────────────────────────────────────────────────

const listStreams = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const { status, sender, recipient, cursor } = req.query;
    const userAddress = req.user?.walletAddress || req.query.address;

    const where = {};

    if (status) {
      where.status = status;
    }

    if (sender) {
      where.senderAddress = sender;
    } else if (recipient) {
      where.recipientAddress = recipient;
    } else if (userAddress) {
      where.OR = [
        { senderAddress: userAddress },
        { recipientAddress: userAddress },
      ];
    }

    const take = limit + 1;
    const rows = await prisma.paymentStream.findMany({
      where,
      take,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { streamId: BigInt(cursor) } } : {}),
      orderBy: [{ createdAt: 'desc' }, { streamId: 'desc' }],
    });

    const hasMore = rows.length > limit;
    const rowsPage = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? String(rowsPage[rowsPage.length - 1].streamId) : null;
    const data = rowsPage.map(serializeStream);

    res.json({ data, pagination: { limit, nextCursor } });
  } catch (err) {
    if (err.message?.includes('Cannot convert')) {
      return res.status(400).json({ error: 'Invalid stream id', detail: 'cursor must be a valid numeric stream id' });
    }
    return sendStreamError(req, res, err, 'list streams', 'could not query payment streams');
  }
};

const getStream = async (req, res) => {
  try {
    const streamId = BigInt(req.params.streamId);

    const stream = await prisma.paymentStream.findUnique({
      where: { streamId },
    });

    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    res.json(serializeStream(stream));
  } catch (err) {
    if (err.message?.includes('Cannot convert')) {
      return res.status(400).json({ error: 'Invalid stream id', detail: 'streamId must be a valid numeric stream id' });
    }
    return sendStreamError(req, res, err, 'get stream', 'could not load the requested payment stream');
  }
};

const getAccrued = async (req, res) => {
  try {
    const streamId = BigInt(req.params.streamId);

    if (!STREAMING_CONTRACT_ID) {
      return res.status(503).json({ error: 'Streaming contract not configured' });
    }

    // Query the contract directly for the live accrued amount
    const { SorobanRpc, Contract, Address, nativeToScVal, BASE_FEE } = await import(
      '@stellar/stellar-sdk'
    );

    const server = new SorobanRpc.Server(
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    );

    const contract = new Contract(STREAMING_CONTRACT_ID);
    const dummyAccount = new (await import('@stellar/stellar-sdk')).Account(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAV',
      '0',
    );

    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const networkPassphrase =
      process.env.STELLAR_NETWORK === 'mainnet'
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015';

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call('accrued', nativeToScVal(streamId, { type: 'u64' })))
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);

    if (SorobanRpc.isSimulationError(simulation)) {
      return res.status(502).json({ error: 'Contract simulation failed', detail: safeErrorMessage(simulation.error, 'contract simulation returned an error') });
    }

    let accrued = 0;
    if (simulation.result?.retval) {
      const native = scValToNative(simulation.result.retval);
      accrued = typeof native === 'bigint' ? native : BigInt(String(native));
    }

    res.json({ streamId: streamId.toString(), accrued: accrued.toString() });
  } catch (err) {
    return sendStreamError(req, res, err, 'query accrued amount', 'could not query the on-chain accrued amount');
  }
};

const buildClaimXdr = async (req, res) => {
  try {
    const streamId = BigInt(req.params.streamId);
    const { recipientAddress } = req.body;

    if (!recipientAddress) {
      return res.status(400).json({ error: 'recipientAddress is required' });
    }

    if (!STREAMING_CONTRACT_ID) {
      return res.status(503).json({ error: 'Streaming contract not configured' });
    }

    const {
      SorobanRpc,
      Contract,
      Address,
      nativeToScVal,
      TransactionBuilder,
      BASE_FEE,
    } = await import('@stellar/stellar-sdk');

    const server = new SorobanRpc.Server(
      process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    );

    const networkPassphrase =
      process.env.STELLAR_NETWORK === 'mainnet'
        ? 'Public Global Stellar Network ; September 2015'
        : 'Test SDF Network ; September 2015';

    const account = await server.getAccount(recipientAddress);
    const contract = new Contract(STREAMING_CONTRACT_ID);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'claim',
          new Address(recipientAddress).toScVal(),
          nativeToScVal(streamId, { type: 'u64' }),
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await server.simulateTransaction(tx);

    if (SorobanRpc.isSimulationError(prepared)) {
      return res.status(422).json({
        error: 'Simulation failed',
        detail: safeErrorMessage(prepared.error, 'simulation failed'),
      });
    }

    const assembled = SorobanRpc.assembleTransaction(tx, prepared).build();
    const unsignedXdr = assembled.toXDR('base64');

    res.json({ unsignedXdr, streamId: streamId.toString() });
  } catch (err) {
    return sendStreamError(req, res, err, 'build claim transaction', 'could not build the claim transaction');
  }
};

export default {
  listStreams,
  getStream,
  getAccrued,
  buildClaimXdr,
};
