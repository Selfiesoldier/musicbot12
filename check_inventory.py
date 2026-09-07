import asyncio
import os
from highrise import BaseBot
from highrise.__main__ import BotDefinition

class InventoryChecker(BaseBot):
    async def on_start(self, session_metadata):
        """Fetch and display complete inventory"""
        print(f"✅ Connected! Bot ID: {session_metadata.user_id}")
        print("📦 Fetching complete inventory from Highrise...\n")
        
        try:
            inventory_response = await self.highrise.get_inventory()
            
            if hasattr(inventory_response, 'items'):
                items = inventory_response.items
                print(f"📊 Total items found: {len(items)}\n")
                
                # Group items by type/prefix
                grouped = {}
                for item in items:
                    item_id = item.id if hasattr(item, 'id') else str(item)
                    item_type = item.type if hasattr(item, 'type') else 'unknown'
                    
                    # Get prefix (e.g., 'shirt-', 'pants-', 'jacket-')
                    prefix = item_id.split('-')[0] if '-' in item_id else item_id
                    
                    if prefix not in grouped:
                        grouped[prefix] = []
                    grouped[prefix].append(item_id)
                
                # Display grouped inventory
                for prefix in sorted(grouped.keys()):
                    items_list = grouped[prefix]
                    print(f"{'='*60}")
                    print(f"{prefix.upper()} ({len(items_list)} items)")
                    print(f"{'='*60}")
                    for idx, item_id in enumerate(items_list, 1):
                        print(f"  {idx}. {item_id}")
                    print()
                
            else:
                print("⚠️ No items found in inventory response")
                
        except Exception as e:
            print(f"❌ Error fetching inventory: {e}")
            import traceback
            traceback.print_exc()
        
        # Exit after checking
        print("\n✅ Inventory check complete!")
        os._exit(0)

if __name__ == "__main__":
    room_id = os.getenv("ROOM_ID")
    bot_token = os.getenv("API_TOKEN")
    
    if not room_id:
        print("❌ ROOM_ID environment variable not found!")
        exit(1)
    
    if not bot_token:
        print("❌ API_TOKEN environment variable not found!")
        exit(1)
    
    bot_definition = BotDefinition(
        bot=InventoryChecker(),
        room_id=room_id,
        api_token=bot_token
    )
    
    asyncio.run(bot_definition.run())
