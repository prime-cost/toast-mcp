// Issue #2: /menus/v2/menus returns { menus: [...] }, not a bare array.
// Run: npm test (builds first, then node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMenusTools } from '../dist/tools/menus.js';
import { registerInventoryTools } from '../dist/tools/inventory.js';

const item = (guid, name, extra = {}) => ({ guid, entityType: 'MenuItem', name, ...extra });
const menusDocument = {
  restaurantGuid: 'rest-1',
  lastUpdated: '2026-09-11T00:00:00.000Z',
  restaurantTimeZone: 'America/Chicago',
  menus: [
    {
      guid: 'menu-a', entityType: 'Menu', name: 'Dinner', visibility: ['POS'],
      groups: [
        { guid: 'grp-1', entityType: 'MenuGroup', name: 'Burgers', items: [
          item('it-1', 'Cheeseburger', { sku: 'CB1' }),
          item('it-2', 'Veggie Burger', { outOfStock86: true }),
        ] },
      ],
    },
    {
      guid: 'menu-b', entityType: 'Menu', name: 'Drinks', visibility: ['POS'],
      groups: [
        { guid: 'grp-2', entityType: 'MenuGroup', name: 'Beer', items: [
          item('it-3', 'Lager', { plu: '9001' }),
        ] },
      ],
    },
  ],
  modifierGroupReferences: {},
  modifierOptionReferences: {},
};

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    getRestaurantGuid: () => 'rest-1',
    async get(endpoint, params) {
      calls.push({ endpoint, params });
      return typeof response === 'function' ? response(endpoint) : response;
    },
    async patch() { throw new Error('not expected'); },
  };
}

const toolsFor = (client) => Object.fromEntries(registerMenusTools(client).map(t => [t.name, t]));

test('toast_list_menus unwraps the document and reports count', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const out = await tools.toast_list_menus.handler({});
  assert.equal(out.count, 2);
  assert.deepEqual(out.menus.map(m => m.guid), ['menu-a', 'menu-b']);
});

test('toast_list_menus still accepts a bare array (older shape)', async () => {
  const tools = toolsFor(fakeClient(menusDocument.menus));
  const out = await tools.toast_list_menus.handler({});
  assert.equal(out.count, 2);
});

test('toast_list_menu_groups no longer throws menus.flatMap is not a function', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const all = await tools.toast_list_menu_groups.handler({});
  assert.equal(all.count, 2);
  const one = await tools.toast_list_menu_groups.handler({ menuGuid: 'menu-b' });
  assert.deepEqual(one.groups.map(g => g.guid), ['grp-2']);
});

test('toast_get_menu selects from the document instead of a per-menu endpoint', async () => {
  const client = fakeClient(menusDocument);
  const tools = toolsFor(client);
  const out = await tools.toast_get_menu.handler({ menuGuid: 'menu-a' });
  assert.equal(out.menu.name, 'Dinner');
  assert.deepEqual(client.calls.map(c => c.endpoint), ['/menus/v2/menus']);
  await assert.rejects(tools.toast_get_menu.handler({ menuGuid: 'nope' }), /not found/);
});

test('toast_get_menu_item walks menus', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const out = await tools.toast_get_menu_item.handler({ itemGuid: 'it-3' });
  assert.equal(out.item.name, 'Lager');
});

test('toast_search_menu_items matches name, sku and plu across menus', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  assert.equal((await tools.toast_search_menu_items.handler({ query: 'burger' })).count, 2);
  assert.equal((await tools.toast_search_menu_items.handler({ query: 'cb1' })).count, 1);
  assert.equal((await tools.toast_search_menu_items.handler({ query: '9001' })).count, 1);
});

test('toast_get_items_by_category and toast_get_86d_items', async () => {
  const tools = toolsFor(fakeClient(menusDocument));
  const cat = await tools.toast_get_items_by_category.handler({ groupGuid: 'grp-1' });
  assert.equal(cat.groupName, 'Burgers');
  assert.equal(cat.count, 2);
  const eightySix = await tools.toast_get_86d_items.handler({});
  assert.deepEqual(eightySix.items.map(i => i.guid), ['it-2']);
});

test('toast_list_low_stock_items iterates the unwrapped menus', async () => {
  const client = fakeClient((endpoint) => {
    if (endpoint === '/menus/v2/menus') return menusDocument;
    // /stock/v1/items/<guid>
    const guid = endpoint.split('/').pop();
    return { guid, quantity: guid === 'it-2' ? 0 : 5, infiniteQuantity: false, outOfStock: guid === 'it-2' };
  });
  const tools = Object.fromEntries(registerInventoryTools(client).map(t => [t.name, t]));
  const out = await tools.toast_list_low_stock_items.handler({});
  assert.deepEqual(out.items.map(i => i.itemGuid), ['it-2']);
});

test('unexpected response shape fails loudly', async () => {
  const tools = toolsFor(fakeClient({ nothing: true }));
  await assert.rejects(tools.toast_list_menus.handler({}), /no menus array/);
});
