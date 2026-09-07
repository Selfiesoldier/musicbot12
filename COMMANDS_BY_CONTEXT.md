# Commands by Context (DM vs Chat)

## 📬 DM-ONLY Commands
These commands can ONLY be used in Direct Messages with the bot.

### System Info Commands (All Users)
- `!system` / `!sysinfo` / `!about` / `!botinfo` / `!info` - View bot system information
- `!version` / `!ver` / `!v` - Show version info
- `!changelog` / `!updates` / `!changes` - Show latest changelog
- `!uptime` - Show bot uptime
- `!feedback <message>` - Submit feedback to developers
- `!reportbug <description>` / `!bugreport` / `!bug` - Report a bug with diagnostics

### System Info Commands (Admin Only, DM)
- `!health` / `!status` / `!diagnostics` - Show system health dashboard
- `!ping` / `!latency` - Check bot response time
- `!stats` / `!statistics` - Show bot statistics
- `!feedbacklogs` / `!viewfeedback` / `!allfeedback` - View all feedback submissions

### Modes Management Commands (Admin Only, DM)
- `!listmodes` - List all modes with details
- `!modesongs <mode>` - View songs in a specific mode
- `!addmode <name> <display> <desc>` - Create a new mode
- `!addsongs <mode> [song1,song2,...]` - Add songs to a mode
- `!removesongs <mode> [song1,song2,...]` - Remove songs from a mode
- `!deletemode <mode>` - Delete a mode

### Background Task Manager (Owner Only, DM)
- `!btm` - Show BTM summary
- `!btm list` - List all background tasks with status
- `!btm start <task>` - Start a background task
- `!btm stop <task>` - Stop a background task
- `!btm restart <task>` - Restart a background task
- `!btm status <task>` - Show task status details
- `!btm help` - Show BTM help

---

## 💬 CHAT-ONLY Commands
These commands can ONLY be used in the room chat.

### Admin Commands (Chat)
- `!addadmin <username>` - Add admin
- `!removeadmin <username>` - Remove admin
- `!addvip <username>` - Add VIP
- `!removevip <username>` - Remove VIP
- `!freemusic <minutes>` - Enable free music mode
- `!stopfreemusic` - Stop free music mode
- `!givepoints <pts> <user/all>` - Gift points (Admin only)
- `!admincmd` - Show admin commands help
- `//restart` / `!restartbot` - Restart bot connection
- `//restartserver` / `!restartserver` - Restart music server
- `//restartboth` / `!restartboth` - Restart both bot and server
- `!pstcmd` - Show position commands help (Admin only)

### Position Commands (Admin Only, Chat)
- `!setmusicbot me` - Set bot position to your spot
- `!setmusicbot X Y Z [facing]` - Set bot position by coordinates

### Outfit Commands (Admin Only, Chat)
- `!wear outfit <name>` - Wear preset outfit
- `!wear <category> <item>` - Wear specific item
- `!remove <category>` - Remove item from category
- `!clearoutfit` - Clear all outfit items
- `!syncoutfit` - Sync outfit from Highrise
- `!skin <0-86>` / `!skincolor <0-86>` - Change skin color
- `!color <category> <0-255>` / `!colour` / `!palette` - Change hair/face colors

### Shop Commands (Chat)
- `!buy <query>` - Search and buy items
- `!confirm` - Confirm pending purchase
- `!cancel` - Cancel pending purchase

---

## 🔀 BOTH (DM & Chat) Commands
These commands work in BOTH Direct Messages AND room chat.

### Music Commands (Public)
- `!play <song>` - Request a song (10 pts, free for VIPs)
- `!dedicate @username <song>` - Dedicate a song (10 pts, free for VIPs)
- `!next` / `!skip` - Vote to skip current song (free)
- `!instskip` - Instant skip (costs 1000 pts)
- `!stop` - Stop playback (5 pts, free for VIPs)
- `!clear` - Clear queue (5 pts/song, free for VIPs)
- `!current` / `!np` - Show current song
- `!queue` - View song queue
- `!autoplay` - Toggle autoplay on/off
- `!modes` - List all available modes
- `!mode <type>` - Switch to a different mode
- `!stream` - Get stream link (sends via DM)
- `!lyrics` - Get lyrics link (sends via DM)
- `!music` - Show music help menu
- `!quality <bitrate>` - Change audio quality (Owner only)
- `!skipvote-` - Cancel active skip vote (Admin only)

### Economy Commands (Public)
- `!balance` / `!points` - Check your balance
- `!packs` / `!packages` - View point packages
- `!costs` / `!prices` - View command costs

### Admin Commands (Both)
- `!admins` - View admin list
- `!vips` - View VIP list
- `!greet` / `!hello` / `!hi` - Personalized greeting
- `!whoami` - Check your role
- `!connection` - Show connection status (Admin only)

### Outfit Commands (Admin Only, Both)
- `!outfit` / `!outfits` - Show current outfit
- `!list [category]` - List items in category
- `!outfitlist` / `!outfitslist` / `!presets` - List outfit presets


### Playlist Commands (VIP+ Only, Both)
- `!myplaylist` - List your playlists
- `!playlist create <name>` - Create new playlist
- `!playlist delete <name>` - Delete playlist
- `!playlist rename <old> <new>` - Rename playlist
- `!playlist show <name>` - View playlist songs
- `!playlist add <playlist> <song>` - Add song to playlist
- `!playlist remove <playlist> <song/index>` - Remove song from playlist
- `!playlist play <name>` - Activate playlist
- `!playlist stop <name>` - Stop playlist
- `!playlist active` - View active playlists
- `!playlist info [name]` - Show playlist info/limits
- `!confirmremove <number>` - Confirm song removal
- `!shufflepl <name>` - Shuffle playlist

### Modes Commands (Public, Both)
- `!modehelp` - Show modes help

---

## 📊 Summary by Context

### DM-Only: ~25 commands
- System info (8)
- Modes management (5)
- Background tasks (6)
- Admin feedback logs (1)

### Chat-Only: ~20 commands
- Admin management (7)
- Position (2)
- Outfit (5)
- Shop (3)
- System (3)

### Both DM & Chat: ~50+ commands
- Music (16)
- Economy (3)
- Playlists (15)
- Admin info (5)
- Outfit info (3)
- Modes (1)

---

## 💡 Notes

1. **DM Response Behavior**: Some commands like `!stream` and `!lyrics` can be used in chat, but they SEND their response via DM
2. **Context Detection**: Commands use `message_context` and `conversation_context` to determine where they were called from
3. **Privacy**: System info, feedback, and bug reports are DM-only for privacy
4. **Admin Commands**: Most admin commands work in chat for quick access, but sensitive ones (BTM, system stats) are DM-only
5. **Modes Management**: DM-only to prevent spam and keep mode configuration clean
6. **Auto-Responses**: The bot sends helpful "This command is DM-only" messages when users try to use DM commands in chat

---

## 🔍 How to Check Command Context

Look for these patterns in the code:

**DM-Only Check:**
```python
if message_context.get() != "dm":
    await send_dm_response(bot, user.id, 
        f"{Colors.ORANGE}⚠️ This command is DM-only!")
    return
```

**Chat Commands:**
```python
await bot.highrise.chat(msg)  # Sends to room chat
```

**Both (context-aware):**
```python
msg_context = message_context.get()
if msg_context == "dm":
    # DM response
else:
    # Chat response