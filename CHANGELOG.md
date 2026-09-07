
# Changelog

## Version 2.1.1 (2024-01-18)

### New Features
- **Skin Tone Color Names**: Added descriptive color names alongside numeric skin tone values
  - Shows both palette ID (0-255) and descriptive name (e.g., "Porcelain", "Fair", "Tan", "Deep Brown")
  - Enhanced `!skin` command to display current skin tone with name
  - Added color range guide in help text for easy selection
  - Ranges: Porcelain (0-10), Fair (11-20), Light (21-30), Light Medium (31-50), Medium (51-80), Medium Tan (81-120), Tan (121-160), Deep Tan (161-200), Rich Brown (201-230), Deep Brown (231-250), Deepest Brown (251-255)

### Improvements
- Better skin color feedback when changing tones
- More intuitive skin tone selection with descriptive ranges

### Commands Updated
- `!skin` - Now displays skin tone name along with palette ID
- `!skin <0-255>` - Shows descriptive name when setting new color

### Bug Fixes
- Fixed item removal at index 0 not working properly
- Corrected 1-based user indexing for item selection

---

## Version 2.1.0 (Previous Release)

### Major Features
- Complete outfit system overhaul with avatar state management
- Modular command system with organized file structure
- Enhanced inventory management
- Outfit preset system with 18+ presets
- VIP and admin access control
- Music queue persistence
- Auto-play modes (kashmiri, bollywood, english, etc.)

### Systems Added
- Admin system with owner/admin/VIP tiers
- Economy system with point packages
- Position management
- Playlist personalization
- System info commands

### Technical Improvements
- Message chunking for long outputs
- Cooldown system for command rate limiting
- Error handling and logging
- Connection stability improvements
- Auto-restart functionality

---

## Future Roadmap
- Health monitoring system
- Centralized logging
- Unified help system
- Queue visualization
- Advanced playlist features
