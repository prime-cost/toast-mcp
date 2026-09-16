import { z } from 'zod';
import { ToastClient } from '../clients/toast.js';
import type { Menu, MenuGroup, MenuItem, ModifierGroup } from '../types/index.js';

/**
 * Menu Management Tools - comprehensive menu, item, and modifier operations
 */

/**
 * GET /menus/v2/menus returns a document, not a bare array: the menus live
 * under `.menus` alongside lastUpdated, restaurantTimeZone and the modifier
 * reference maps. Every tool that walks menus must unwrap it (issue #2).
 */
interface MenusDocument {
  restaurantGuid?: string;
  lastUpdated?: string;
  restaurantTimeZone?: string;
  menus: Menu[];
}

export async function fetchMenus(client: ToastClient, restaurantGuid: string): Promise<Menu[]> {
  const res = await client.get<MenusDocument | Menu[]>(
    `/menus/v2/menus`,
    { restaurantGuid }
  );
  const menus = Array.isArray(res) ? res : res?.menus;
  if (!Array.isArray(menus)) {
    throw new Error('Unexpected /menus/v2/menus response: no menus array');
  }
  return menus;
}

function allItems(menus: Menu[]): MenuItem[] {
  return menus.flatMap(menu => (menu.groups || []).flatMap(group => group.items || []));
}

export function registerMenusTools(client: ToastClient) {
  return [
    {
      name: 'toast_list_menus',
      description: 'List all menus for a restaurant',
      inputSchema: z.object({
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);
        return { menus, count: menus.length };
      },
    },

    {
      name: 'toast_get_menu',
      description: 'Get detailed information about a specific menu including all groups and items',
      inputSchema: z.object({
        menuGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { menuGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        // Menus v2 has no per-menu endpoint; pull the document and select.
        const menus = await fetchMenus(client, restGuid);
        const menu = menus.find(m => m.guid === args.menuGuid);
        if (!menu) {
          throw new Error(`Menu ${args.menuGuid} not found`);
        }
        return { menu };
      },
    },

    {
      name: 'toast_get_menu_item',
      description: 'Get detailed information about a specific menu item',
      inputSchema: z.object({
        itemGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        // Menus v2 has no per-item endpoint; pull the document and select.
        const menus = await fetchMenus(client, restGuid);
        const item = allItems(menus).find(i => i.guid === args.itemGuid);
        if (!item) {
          throw new Error(`Menu item ${args.itemGuid} not found`);
        }
        return { item };
      },
    },

    {
      name: 'toast_search_menu_items',
      description: 'Search menu items by name, SKU, or PLU',
      inputSchema: z.object({
        query: z.string().describe('Search query (name, SKU, or PLU)'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { query: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        const query = args.query.toLowerCase();
        const matchingItems = allItems(menus).filter(item =>
          item.name?.toLowerCase().includes(query) ||
          item.sku?.toLowerCase().includes(query) ||
          item.plu?.toLowerCase().includes(query)
        );

        return { items: matchingItems, count: matchingItems.length };
      },
    },

    {
      name: 'toast_update_item_price',
      description: 'Update the price of a menu item',
      inputSchema: z.object({
        itemGuid: z.string(),
        price: z.number().describe('New price in cents (e.g., 1250 for $12.50)'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; price: number; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const result = await client.patch(
          `/menus/v2/items/${args.itemGuid}`,
          { price: args.price },
          { params: { restaurantGuid: restGuid } }
        );
        return { success: true, result };
      },
    },

    {
      name: 'toast_set_item_86',
      description: 'Mark an item as out of stock (86\'d) or back in stock',
      inputSchema: z.object({
        itemGuid: z.string(),
        outOfStock: z.boolean().describe('true to mark 86\'d, false to mark available'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuid: string; outOfStock: boolean; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const result = await client.patch(
          `/menus/v2/items/${args.itemGuid}`,
          { outOfStock86: args.outOfStock },
          { params: { restaurantGuid: restGuid } }
        );
        return { success: true, itemGuid: args.itemGuid, outOfStock: args.outOfStock };
      },
    },

    {
      name: 'toast_get_modifier_group',
      description: 'Get details about a modifier group (e.g., toppings, sides)',
      inputSchema: z.object({
        modifierGroupGuid: z.string(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { modifierGroupGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const modifierGroup = await client.get<ModifierGroup>(
          `/menus/v2/modifierGroups/${args.modifierGroupGuid}`,
          { restaurantGuid: restGuid }
        );
        return { modifierGroup };
      },
    },

    {
      name: 'toast_list_menu_groups',
      description: 'List all menu groups (categories) across all menus',
      inputSchema: z.object({
        menuGuid: z.string().optional().describe('Filter by specific menu GUID'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { menuGuid?: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        if (args.menuGuid) {
          const menu = menus.find(m => m.guid === args.menuGuid);
          if (!menu) {
            throw new Error(`Menu ${args.menuGuid} not found`);
          }
          const groups = menu.groups || [];
          return { groups, count: groups.length };
        }

        const allGroups = menus.flatMap(menu => menu.groups || []);
        return { groups: allGroups, count: allGroups.length };
      },
    },

    {
      name: 'toast_get_items_by_category',
      description: 'Get all menu items in a specific category/group',
      inputSchema: z.object({
        groupGuid: z.string().describe('Menu group GUID'),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { groupGuid: string; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        let foundGroup: MenuGroup | undefined;
        for (const menu of menus) {
          foundGroup = (menu.groups || []).find(g => g.guid === args.groupGuid);
          if (foundGroup) break;
        }

        if (!foundGroup) {
          throw new Error(`Menu group ${args.groupGuid} not found`);
        }

        return { items: foundGroup.items, groupName: foundGroup.name, count: foundGroup.items.length };
      },
    },

    {
      name: 'toast_get_86d_items',
      description: 'Get all items currently marked as out of stock (86\'d)',
      inputSchema: z.object({
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const menus = await fetchMenus(client, restGuid);

        const outOfStockItems = allItems(menus).filter(item => item.outOfStock86 || item.inheritedOutOfStock86);

        return { items: outOfStockItems, count: outOfStockItems.length };
      },
    },

    {
      name: 'toast_bulk_86_items',
      description: 'Mark multiple items as out of stock (86\'d) at once',
      inputSchema: z.object({
        itemGuids: z.array(z.string()),
        outOfStock: z.boolean(),
        restaurantGuid: z.string().optional(),
      }),
      handler: async (args: { itemGuids: string[]; outOfStock: boolean; restaurantGuid?: string }) => {
        const restGuid = args.restaurantGuid || client.getRestaurantGuid();
        const results = await Promise.all(
          args.itemGuids.map(itemGuid =>
            client.patch(
              `/menus/v2/items/${itemGuid}`,
              { outOfStock86: args.outOfStock },
              { params: { restaurantGuid: restGuid } }
            ).catch(err => ({ error: err.message, itemGuid }))
          )
        );

        const successful = results.filter(r => !(r && typeof r === 'object' && 'error' in r));
        const failed = results.filter(r => r && typeof r === 'object' && 'error' in r);

        return {
          successCount: successful.length,
          failCount: failed.length,
          failed: failed,
        };
      },
    },
  ];
}
