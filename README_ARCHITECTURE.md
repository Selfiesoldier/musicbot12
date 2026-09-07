# Music Bot - Modular Architecture

## 🎯 Overview

This bot has been completely modularized into a professional, scalable architecture. Each system is now isolated, maintainable, and easy to upgrade.

## 📁 Project Structure

```
/
├── main.py                 # Main bot entry point
├── loader.py              # Automatic command loader
├── bot_old.py            # Backup of original bot (for reference)
│
├── core/                  # Core utilities and helpers
│   ├── utils.py          # Utility functions (JSON, formatting)
│   ├── decorators.py     # Command decorators (admin_only, etc.)
│   └── events.py         # Event bus system
│
├── systems/              # All bot subsystems
│   ├── music/           # Music playback system
│   │   ├── music_manager.py
│   │   ├── queue_manager.py
│   │   ├── music_commands.py
│   │   └── data/
│   │
│   ├── economy/         # Points and economy
│   │   ├── economy_manager.py
│   │   ├── point_packs.py
│   │   ├── economy_commands.py
│   │   └── data/
│   │       └── user_balances.json
│   │
│   ├── admin/           # Admin and VIP management
│   │   ├── admin_manager.py
│   │   ├── admin_commands.py
│   │   └── data/
│   │       └── admins.json
│   │
│   ├── outfits/         # Wardrobe and inventory
│   │   ├── inventory_manager.py
│   │   ├── wardrobe_manager.py
│   │   └── data/
│   │       └── bot_inventory.json
│   │
│   ├── shop/            # Item purchasing
│   │   ├── shop_manager.py
│   │   ├── item_search.py
│   │   └── data/
│   │
│   ├── position/        # Bot position management
│   │   ├── position_manager.py
│   │   ├── position_commands.py
│   │   └── data/
│   │       └── default_position.json
│   │
│   └── modes/           # Mode and playlist management
│       ├── mode_manager.py
│       ├── recent_songs_manager.py
│       ├── kashmiri_songs_manager.py
│       └── data/
│           ├── mode_config.json
│           ├── recent_songs.json
│           └── kashmiri_songs.json
│
└── handlers/            # Event handlers
    ├── chat_handler.py  # Chat message routing
    ├── tip_handler.py   # Tip processing
    └── join_handler.py  # User join events
```

## ✨ Key Benefits

### ✅ Modular Design
- Each system is independent
- Easy to add/remove features
- Clear separation of concerns

### ✅ Clean Command Loading
- Automatic command registration
- No manual command routing
- Support for command aliases

### ✅ Isolated Data
- Each system manages its own data
- No cross-contamination
- Easy to backup/restore

### ✅ Maintainability
- Easy debugging (isolated systems)
- Simple to upgrade individual modules
- Clean import structure

## 🔄 How Command Loading Works

1. **Command Registration**: Each system has a `*_commands.py` file with a `register(bot)` function
2. **Automatic Loading**: `loader.py` automatically discovers and loads all command modules
3. **Command Registry**: Commands are registered with aliases support
4. **Handler Routing**: `chat_handler.py` routes messages to the correct command

## 🚀 Adding a New System

1. Create a new directory in `systems/`
2. Add your manager file
3. Create `{system}_commands.py` with a `register(bot)` function
4. Commands will automatically load on next restart!

Example:
```python
# systems/newsystem/newsystem_commands.py
def register(bot):
    @bot.command("mycommand")
    async def my_command(user, message):
        await bot.highrise.chat("Hello!")
```

## 📝 Data Management

Each system stores its data in its own `data/` folder:
- `systems/economy/data/user_balances.json`
- `systems/admin/data/admins.json`
- `systems/modes/data/recent_songs.json`
- etc.

This makes it easy to backup, migrate, or reset individual systems.

## 🔧 Configuration

- Bot configuration: Environment variables (ROOM_ID, API_TOKEN)
- System data: JSON files in each `systems/*/data/` directory
- Position: `systems/position/data/default_position.json`

## 📊 Command Registry

The bot uses a flexible command registry that supports:
- Primary command names
- Command aliases
- Dynamic handler lookup
- Clean separation from business logic

## 🎵 Systems Overview

### Music System
- Handles playback, queue, and streaming
- Auto-play with multiple modes
- Integration with music server

### Economy System
- Points and balances
- Tip processing
- Point packages

### Admin System
- Owner/Admin/VIP hierarchy
- Permission checking
- Access control

### Outfits System
- Inventory management
- Wardrobe presets
- Item wearing/removal

### Shop System
- Item search
- Purchase flow
- Inventory integration

### Position System
- Default position saving
- Teleport commands
- Coordinate management

### Modes System
- Playlist modes
- Recent songs tracking
- Kashmiri songs management

## 🌟 Next Steps

With this modular architecture, you can now:

1. **Add New Features**: Just create a new system folder
2. **Upgrade Existing**: Modify only the relevant system
3. **Debug Easily**: Issues are isolated to specific modules
4. **Scale Up**: Add more systems without touching others
5. **Team Collaboration**: Different developers can work on different systems

## 🎯 Migration Notes

- Original `bot.py` backed up as `bot_old.py`
- All functionality preserved
- Data files moved to respective system folders
- Old folder structure can be removed after verification
