/**
 * Unit tests for api/controllers/referralController.js
 *
 * Focused on the edge cases and unhappy paths that were previously untested:
 *  - missing / malformed input (no code, invalid code format)
 *  - unauthenticated / unlinked wallet (403) and missing user (404)
 *  - conflict paths (already owns a code, code taken globally)
 *  - service / database failures degrade to 500 with a logged error
 */

import { jest } from '@jest/globals';

// Controller internal imports (resolved relative to the controller):
//   ../../lib/prisma.js            -> backend/lib/prisma.js
//   ../../config/logger.js         -> backend/config/logger.js
//   ../middleware/authorization.js -> backend/api/middleware/authorization.js
//   ../../services/referralService.js
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule('../../config/logger.js', () => ({
  createModuleLogger: () => loggerMock,
  logControllerError: jest.fn(),
}));

const {
  logControllerError,
} = await import('../../config/logger.js');

const prismaMock = {
  user: {
    findUnique: jest.fn(),
  },
  referralCode: {
    findFirst: jest.fn(),
  },
  referralEarning: {
    count: jest.fn(),
  },
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));

const getAuthenticatedWalletAddressMock = jest.fn();
jest.unstable_mockModule('../../api/middleware/authorization.js', () => ({
  getAuthenticatedWalletAddress: getAuthenticatedWalletAddressMock,
}));

const referralServiceMock = {
  createReferralCode: jest.fn(),
  getMyStats: jest.fn(),
  selectPendingPayoutBatch: jest.fn(),
  markPaidOut: jest.fn(),
};
jest.unstable_mockModule('../../services/referralService.js', () => ({
  default: referralServiceMock,
}));

let referralController;

beforeAll(async () => {
  referralController = (await import('../../api/controllers/referralController.js')).default;
});

beforeEach(() => {
  jest.clearAllMocks();
  getAuthenticatedWalletAddressMock.mockReturnValue('GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
  prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
});

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (payload) {
    res.body = payload;
    return res;
  };
  return res;
}

describe('referralController.createCode', () => {
  it('returns 403 when the authenticated user has no linked wallet', async () => {
    getAuthenticatedWalletAddressMock.mockReturnValue(null);
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not linked to a wallet/i);
  });

  it('returns 400 when the code is missing', async () => {
    const req = { body: {} };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/1-32 alphanumeric\/underscore/i);
    expect(prismaMock.referralCode.findFirst).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed codes (spaces, symbols, too long)', async () => {
    for (const bad of ['has space', '!!invalid!!', 'x'.repeat(33), 'UPPER-lower', '']) {
      const req = { body: { code: bad } };
      const res = makeRes();
      await referralController.createCode(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/1-32 alphanumeric\/underscore/i);
    }
  });

  it('returns 404 when no user account is found for the wallet', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/no user account/i);
  });

  it('returns 409 when the user already owns a referral code', async () => {
    prismaMock.referralCode.findFirst.mockResolvedValue({ code: 'OLDCODE' });
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already have a referral code/i);
    expect(res.body.code).toBe('OLDCODE');
  });

  it('returns 409 when the code is already taken globally (CODE_TAKEN)', async () => {
    prismaMock.referralCode.findFirst.mockResolvedValue(null);
    referralServiceMock.createReferralCode.mockRejectedValue({ code: 'CODE_TAKEN' });
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already taken/i);
  });

  it('creates a code successfully and returns 201', async () => {
    prismaMock.referralCode.findFirst.mockResolvedValue(null);
    referralServiceMock.createReferralCode.mockResolvedValue({ code: 'ALICE1' });
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.code).toBe('ALICE1');
    expect(referralServiceMock.createReferralCode).toHaveBeenCalledWith('user-1', 'ALICE1');
  });

  it('returns 500 and logs on an unexpected failure', async () => {
    prismaMock.referralCode.findFirst.mockResolvedValue(null);
    referralServiceMock.createReferralCode.mockRejectedValue(new Error('db down'));
    const req = { body: { code: 'ALICE1' } };
    const res = makeRes();

    await referralController.createCode(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/failed to create referral code/i);
    expect(logControllerError).toHaveBeenCalled();
  });
});

describe('referralController.getMyStats', () => {
  it('returns 403 when the authenticated user has no linked wallet', async () => {
    getAuthenticatedWalletAddressMock.mockReturnValue(null);
    const req = {};
    const res = makeRes();

    await referralController.getMyStats(req, res);

    expect(res.statusCode).toBe(403);
  });

  it('returns default zeroed stats when the user has no referral data', async () => {
    referralServiceMock.getMyStats.mockResolvedValue(null);
    const req = {};
    const res = makeRes();

    await referralController.getMyStats(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      code: null,
      totalReferrals: 0,
      pendingEarnings: '0',
      totalEarned: '0',
      topReferred: [],
    });
  });

  it('returns the aggregated stats when present', async () => {
    const stats = {
      code: 'BOB1',
      totalReferrals: 3,
      pendingEarnings: '12.5',
      totalEarned: '40.0',
      topReferred: [{ escrowId: '10', earnedXlm: '5.0' }],
    };
    referralServiceMock.getMyStats.mockResolvedValue(stats);
    const req = {};
    const res = makeRes();

    await referralController.getMyStats(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(stats);
  });

  it('returns 500 and logs when the stats lookup fails', async () => {
    referralServiceMock.getMyStats.mockRejectedValue(new Error('boom'));
    const req = {};
    const res = makeRes();

    await referralController.getMyStats(req, res);

    expect(res.statusCode).toBe(500);
    expect(logControllerError).toHaveBeenCalled();
  });
});

describe('referralController.payOutBatch', () => {
  it('returns zeros when there is no pending batch', async () => {
    referralServiceMock.selectPendingPayoutBatch.mockResolvedValue([]);
    const req = {};
    const res = makeRes();

    await referralController.payOutBatch(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ paidCount: 0, remainingPending: 0 });
    expect(referralServiceMock.markPaidOut).not.toHaveBeenCalled();
  });

  it('marks a pending batch paid and returns the remaining count', async () => {
    referralServiceMock.selectPendingPayoutBatch.mockResolvedValue([
      { id: 'e1' },
      { id: 'e2' },
    ]);
    prismaMock.referralEarning.count.mockResolvedValue(5);

    const req = {};
    const res = makeRes();

    await referralController.payOutBatch(req, res);

    expect(res.statusCode).toBe(200);
    expect(referralServiceMock.markPaidOut).toHaveBeenCalledWith(['e1', 'e2']);
    expect(res.body).toMatchObject({
      paidCount: 2,
      remainingPending: 5,
      batch: ['e1', 'e2'],
    });
  });

  it('returns 500 and logs when the batch fails', async () => {
    referralServiceMock.selectPendingPayoutBatch.mockRejectedValue(new Error('boom'));
    const req = {};
    const res = makeRes();

    await referralController.payOutBatch(req, res);

    expect(res.statusCode).toBe(500);
    expect(logControllerError).toHaveBeenCalled();
  });
});
