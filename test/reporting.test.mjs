// Issue #1: check-level discounts were subtracted twice in toast_get_sales_summary.
// Run: npm test (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerReportingTools } from '../dist/tools/reporting.js';

const disc = (guid, discountAmount, name = 'Disc') => ({
  guid, discountGuid: `cfg-${name}`, name, amount: discountAmount, discountAmount,
});

// Toast's check.amount is already net of every discount on the check.
// Two checks:
//  - check 1: $100 of items, $20 check-level discount            -> amount 80
//  - check 2: $50 of items, $5 item-level comp on one selection   -> amount 45
// Web "Net Sales Summary" would show gross 150, discounts 25, net 125.
const orders = [
  {
    guid: 'o1', voided: false, numberOfGuests: 2,
    checks: [
      {
        guid: 'c1', amount: 80, taxAmount: 6.6, totalAmount: 86.6,
        appliedDiscounts: [disc('ad-1', 20, '20 off')],
        selections: [
          { guid: 's1', voided: false, preDiscountPrice: 60, price: 48 },
          { guid: 's2', voided: false, preDiscountPrice: 40, price: 32 },
        ],
        payments: [{ tipAmount: 15 }],
      },
      {
        guid: 'c2', amount: 45, taxAmount: 3.71, totalAmount: 48.71,
        appliedDiscounts: [],
        selections: [
          { guid: 's3', voided: false, preDiscountPrice: 50, price: 45,
            appliedDiscounts: [disc('ad-2', 5, 'Loyalty')] },
          // voided selection carrying a discount must be ignored
          { guid: 's4', voided: true, preDiscountPrice: 10, price: 0,
            appliedDiscounts: [disc('ad-void', 10, 'Void comp')] },
        ],
        payments: [],
      },
    ],
  },
  // voided order: excluded from sales, counted in voidAmount
  { guid: 'o2', voided: true, numberOfGuests: 1, checks: [{ guid: 'c3', amount: 30, totalAmount: 32.5, appliedDiscounts: [disc('ad-3', 5)] }] },
];

function fakeClient(data) {
  return {
    getRestaurantGuid: () => 'rest-1',
    async getAllPages() { return data; },
    async get() { throw new Error('not expected'); },
  };
}
const toolsFor = (client) => Object.fromEntries(registerReportingTools(client).map(t => [t.name, t]));
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} != ${b}`);

test('sales summary counts check-level discounts once', async () => {
  const tools = toolsFor(fakeClient(orders));
  const out = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(out.grossSales, 150);
  close(out.discountAmount, 25);
  close(out.netSales, 125);            // was 105 before the fix (20 subtracted twice)
  close(out.netSales, 80 + 45);        // net == sum of check.amount
  close(out.totalSales, 86.6 + 48.71);
  close(out.tipAmount, 15);
  close(out.voidAmount, 32.5);
  assert.equal(out.checkCount, 2);
  assert.equal(out.guestCount, 2);
});

test('a discount surfaced at both check and selection level is counted once', async () => {
  const shared = disc('ad-shared', 10, 'Manager comp');
  const data = [{
    guid: 'o1', voided: false, numberOfGuests: 1,
    checks: [{
      guid: 'c1', amount: 90, taxAmount: 0, totalAmount: 90,
      appliedDiscounts: [shared],
      selections: [{ guid: 's1', voided: false, preDiscountPrice: 100, price: 90, appliedDiscounts: [shared] }],
      payments: [],
    }],
  }];
  const tools = toolsFor(fakeClient(data));
  const summary = await tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
  close(summary.grossSales, 100);
  close(summary.discountAmount, 10);
  close(summary.netSales, 90);
  const report = await tools.toast_get_discount_report.handler({ businessDate: 20260911 });
  const total = report.discounts.reduce((s, d) => s + d.amount, 0);
  close(total, 10);
  assert.equal(report.discounts[0].count, 1);
});

// Issue #4: four fields still differed from Toast Web's Sales summary on a day
// with refunds, waste or voided discounts. Cases below are the reporter's.
const summaryOf = async (checks) => {
  const tools = toolsFor(fakeClient([{ guid: 'o1', voided: false, numberOfGuests: 1, checks }]));
  return tools.toast_get_sales_summary.handler({ businessDate: 20260911 });
};

test('refunds come off net sales, net of tax and of refunded tips', async () => {
  const out = await summaryOf([
    // whole check refunded: 29.96 back, 1.96 of it tax -> 28.00 off net
    { guid: 'c1', amount: 28, taxAmount: 1.96, totalAmount: 29.96, selections: [],
      payments: [{ paymentStatus: 'CAPTURED', tipAmount: 0, refund: { refundAmount: 29.96, tipRefundAmount: 0 } }] },
    // selection voided after payment: check total is 0, so no tax to prorate
    { guid: 'c2', amount: 0, taxAmount: 0, totalAmount: 0, selections: [],
      payments: [{ paymentStatus: 'CAPTURED', tipAmount: 0, refund: { refundAmount: 14.98, tipRefundAmount: 0 } }] },
    // half a check: tax prorated 4.00 * (27/54) = 2.00 -> 25.00 off net
    { guid: 'c3', amount: 50, taxAmount: 4, totalAmount: 54, selections: [],
      payments: [{ paymentStatus: 'CAPTURED', tipAmount: 0, refund: { refundAmount: 27, tipRefundAmount: 0 } }] },
    // refund carries a tip, so it exceeds the check total: never claw back
    // more tax than the check had, and take the tip portion off separately
    { guid: 'c4', amount: 10, taxAmount: 0, totalAmount: 10, selections: [],
      payments: [{ paymentStatus: 'CAPTURED', tipAmount: 3, refund: { refundAmount: 13, tipRefundAmount: 3 } }] },
  ]);
  close(out.refundGrossAmount, 29.96 + 14.98 + 27 + 13);
  close(out.refundAmount, 28 + 14.98 + 25 + 10);
  close(out.netSales, (28 + 0 + 50 + 10) - (28 + 14.98 + 25 + 10));
});

test('VOID-state and Waste discounts stay out of gross and out of discounts', async () => {
  const out = await summaryOf([
    { guid: 'c1', amount: 45, taxAmount: 0, totalAmount: 45, payments: [],
      appliedDiscounts: [
        disc('ad-real', 5, 'Open Check %'),
        { guid: 'ad-void', discountGuid: 'cfg', name: 'Open Check %', amount: 2.8,
          discountAmount: 2.8, processingState: 'VOID' },
      ],
      selections: [] },
    // two selections comped 100% as waste: outside gross, and not a discount
    { guid: 'c2', amount: 0, taxAmount: 0, totalAmount: 0, payments: [], appliedDiscounts: [],
      selections: [
        { guid: 's1', voided: false, appliedDiscounts: [disc('ad-w1', 6.25, 'Waste')] },
        { guid: 's2', voided: false, appliedDiscounts: [disc('ad-w2', 8.35, ' waste ')] },
      ] },
  ]);
  close(out.grossSales, 50);       // 45 + the 5.00 real discount, nothing else
  close(out.discountAmount, 5);
  close(out.netSales, 45);         // symmetric, so net is untouched
});

test('tips count only on payments that went live', async () => {
  const out = await summaryOf([
    { guid: 'c1', amount: 20, taxAmount: 0, totalAmount: 20, selections: [], payments: [
      // the guest retried after a decline; both rows carry the same tip
      { paymentStatus: 'DENIED', tipAmount: 7.42 },
      { paymentStatus: 'CAPTURED', tipAmount: 7.42 },
      { paymentStatus: 'VOIDED', tipAmount: 5 },
      { paymentStatus: 'AUTHORIZED', tipAmount: 2 },
      { paymentStatus: 'PROCESSED', tipAmount: 1 },
    ] },
  ]);
  close(out.tipAmount, 7.42 + 2 + 1);
});
