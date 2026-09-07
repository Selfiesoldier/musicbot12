# Highrise Music Bot

## Overview
The Highrise Music Bot is a hybrid system designed to enhance the Highrise social platform with interactive music capabilities. It integrates a Python-based Highrise Bot for event handling and command processing with a Node.js Music Backend Server for streaming YouTube audio. This allows Highrise users to request and play YouTube songs within a virtual room, fostering an engaging community experience and introducing a unique in-game economy centered around music. The project aims to provide seamless music playback, robust bot management, and dynamic interaction features.

## User Preferences
I want the agent to use clear, concise language, avoiding jargon where possible. When suggesting changes or new features, please explain the "why" behind them, not just the "what." I prefer an iterative development approach, where we can discuss and agree upon smaller, manageable changes rather than large, sweeping ones. Please ask for confirmation before implementing any significant changes to the codebase or architectural decisions. Do not make changes to the `data/user_balances.json` and `data/mode_config.json` files.

## System Architecture

### Core Architecture
The project employs a clean, modular architecture composed of a Python Highrise Bot and a Node.js Music Backend Server. The Python bot utilizes an event-driven design based on `highrise-bot-sdk` for command processing and event handling. The Node.js server handles music streaming from YouTube.

**Design Principles:**
-   **Modularity:** Independent systems (Music, Economy, Admin, Outfits, Shop, Position, Modes) ensure isolated development and maintenance.
-   **Persistence:** Data for each system is stored in dedicated JSON files.
-   **Auto-Loading:** Commands are dynamically registered via a central loader.
-   **Clean Separation:** Clear distinction between business logic, commands, and data layers.
-   **Scalability:** Designed for easy integration of new features and systems.
-   **Reliability:** Centralized error handling prevents crashes and logs all system events.

### Key Features & Implementations

-   **Background Task Manager (BTM):** Manages all background loops with auto-restart on crash, duplicate prevention, uptime tracking, and owner notifications.
-   **Dynamic Modes System:** JSON-based management of music autoplay modes, allowing runtime creation, modification, and deletion of modes (e.g., "recent", genre-specific).
-   **Music Attribution System:** Tracks and displays song ownership (playlist, requester, dedication) in announcements, persisting attribution metadata across playback scenarios.
-   **Personalized Messaging System:** Delivers role-based custom messages (Owner, Admins, VIPs, Normal users) with unique styling.
-   **Universal Message Chunking System:** Automatically intercepts and chunks ALL Highrise messages (chat, whisper, DM) to strictly enforce the 240-character limit. Provides transparent, zero-configuration protection against message errors across the entire codebase.
-   **Duplicate Song Prevention:** Automatically detects and prevents duplicate queue entries, managing point refunds and user notifications.
-   **DM-Only System Info Commands:** Restricts sensitive system information and management commands to Direct Messages for security and to prevent chat spam.
-   **Centralized Error Handling:** Catches and logs all errors from commands, events, and background tasks, providing robust crash prevention and user feedback.
-   **Cooldown System:** Implements command-specific and global cooldowns to prevent abuse and API rate limit issues.
-   **Persistent Queue System:** Saves and restores the music queue across bot/server restarts. The currently playing song is preserved and automatically resumes playback (from the beginning) after a restart, ensuring no songs are skipped.
-   **Health Monitor System:** Monitors critical bot components (music server, autoplay) and automatically addresses issues to maintain uptime.
-   **Centralized Logging System:** Comprehensive logging of all bot activities (commands, economy, tips, system, errors) for debugging and auditing.
-   **System Info & Feedback System:** Provides diagnostics, version tracking, feedback submission, and bug reporting, accessible via DM-only commands.
-   **Advanced Autoplay Protection (Nov 2024):** Multi-layer protection prevents duplicate autoplay songs through transition state tracking, timestamp guards (15s cooldown), and async locking. Autoplay checks every 10 seconds and respects server transition states.
-   **Enhanced Server Watchdog (Nov 2024):** Automatic log rotation (5MB limit, keeps last 5 archives), daily restart limit protection (100/day), fixed async bugs, and comprehensive restart tracking for long-term stability.
-   **Listener Verification System (Dec 2024):** Token-based tracking to monitor which room users are connected to the music stream. Features personalized stream links with unique tokens, connection/disconnection tracking, and admin commands for verification. Commands: `!listeners` (show connection status), `!verifylisteners` (sync room users and send links to non-listeners), `!connectall` (start auto-connect loop that periodically reminds non-listeners up to 3 times), `!stopconnect` (stop the auto-connect loop). API endpoints: `/register-listener`, `/listener-status`, `/get-user-link`, `/update-expected-listeners`, `/remove-listener`.
-   **Persistent Streaming Architecture (Dec 2024):** Production-grade radio-style streaming with a single, never-stopping FFmpeg encoder. Key features:
    - **Persistent FFmpeg Encoder:** One FFmpeg process starts on server boot and runs continuously - audio is piped through without restarts between songs
    - **PCM Audio Pipeline:** All songs are decoded to raw PCM (s16le, 44100Hz, stereo) before being fed to the persistent encoder, ensuring consistent audio format
    - **Silence Feed:** Continuous silence is fed when no songs are playing, keeping the stream alive and clients connected
    - **Transition Silence:** 300ms of silence is injected between songs for smooth, seamless transitions
    - **Health Watchdog:** 30-second interval health check monitors encoder status and auto-restarts if crashed
    - **TTS Disabled:** Voice announcements removed from audio stream for stability - song info announced via chat only
    - **No Disconnections:** Clients never disconnect between songs since the stream never stops
    - Designed to feel like professional radio with stable, uninterrupted playback.

## External Dependencies
-   **Highrise Bot API:** Core platform interaction for the bot.
-   **`highrise-bot-sdk` (Python):** SDK for Highrise bot development.
-   **`yt-dlp` (Node.js/CLI):** Used by the Node.js backend for YouTube audio downloading and streaming.
-   **`yt-search` (Node.js):** Used by the Node.js backend for YouTube video search functionality.
-   **`FFmpeg` (CLI):** Utilized by the Node.js music server for audio transcoding.