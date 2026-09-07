"""
Anchor Guardian Loop - Anti-drift & Auto-docking Position Watchdog.

Inspired by pakbotgem's startAnchorGuardian system:
1. Performs staggered initial repositioning (1s, 2.5s, 4s) to firmly dock the bot as room loads.
2. Runs a continuous lightweight watchdog every 4 seconds.
3. Automatically detects drift, displacement, or bumps (> 0.4m), or furniture anchor mismatches,
   and snaps the bot back to its exact anchor coordinates/seat.
"""
import asyncio
import math
import sys
import time
from highrise import Position, AnchorPosition
from core.error_handler import safe_call
from core.logger import write_system_log

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


async def anchor_guardian_loop(bot):
    """Periodically monitors and anchors the bot avatar to its designated position."""
    print("⚓ Anchor Guardian watchdog initialized, running startup docking...")
    write_system_log("Anchor Guardian loop started")

    # Staggered initial triggers (1.0s, 2.5s, 4.0s) to guarantee bot arrives at home
    # regardless of room loading time or asset synchronization.
    try:
        await asyncio.sleep(1.0)
        await _ensure_home(bot, "Initial startup dock (1.0s)")
        await asyncio.sleep(1.5)
        await _ensure_home(bot, "Initial startup dock (2.5s)")
        await asyncio.sleep(1.5)
        await _ensure_home(bot, "Initial startup dock (4.0s)")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"⚠️ Startup docking notice: {e}")

    print("✅ Anchor Guardian loop active and watching!")

    while True:
        try:
            await safe_call(lambda: _anchor_guardian_tick(bot))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            err = str(e).lower()
            if "closing" not in err and "connection" not in err and "transport" not in err:
                print(f"⚠️ Anchor Guardian tick error: {e}")

        # Watchdog interval: 4 seconds (ultra-efficient, matches pakbotgem)
        await asyncio.sleep(4.0)


async def _ensure_home(bot, reason: str = ""):
    """Helper to snap the bot back to its saved anchor position."""
    if not bot or not bot.bot_user_id or not bot.position_manager:
        return
    if not bot.position_manager.has_position():
        return

    home = bot.position_manager.get_position()
    if not home:
        return

    success = await bot.position_manager.ensure_home_position(bot)
    if success and reason:
        # Subtle debug notice if needed
        pass


async def _anchor_guardian_tick(bot):
    """Executes a single watchdog check comparing live avatar position with saved anchor."""
    if not bot or not bot.bot_user_id or not bot.position_manager:
        return

    home = bot.position_manager.get_position()
    if not home:
        return

    # Check live position in room
    try:
        response = await bot.highrise.get_room_users()
    except Exception:
        return

    if not hasattr(response, 'content'):
        return

    bot_live_pos = None
    for room_user, pos in response.content:
        if room_user.id == bot.bot_user_id:
            bot_live_pos = pos
            break

    if not bot_live_pos:
        return

    # Case 1: Saved home is an AnchorPosition (furniture / chair / booth)
    if isinstance(home, AnchorPosition):
        if (
            not isinstance(bot_live_pos, AnchorPosition)
            or bot_live_pos.entity_id != home.entity_id
            or bot_live_pos.anchor_ix != home.anchor_ix
        ):
            print(f"⚓ [Anchor Guardian] Furniture anchor displacement detected. Reseating bot to {home.entity_id} #{home.anchor_ix}")
            write_system_log(f"Anchor Guardian: Reseating bot to furniture anchor {home.entity_id} #{home.anchor_ix}")
            await bot.position_manager.ensure_home_position(bot)
        return

    # Case 2: Saved home is a standard coordinate Position
    if isinstance(home, Position):
        # If bot is currently sitting on furniture while home is a coordinate spot
        if isinstance(bot_live_pos, AnchorPosition):
            print(f"⚓ [Anchor Guardian] Bot is on furniture while home is coordinate spot ({home.x:.1f}, {home.y:.1f}, {home.z:.1f}). Snapping back...")
            write_system_log("Anchor Guardian: Snapping bot from furniture back to coordinate home")
            await bot.position_manager.ensure_home_position(bot)
            return

        # Both are Positions: calculate drift distance
        if isinstance(bot_live_pos, Position):
            dist = math.hypot(bot_live_pos.x - home.x, bot_live_pos.z - home.z) + abs(bot_live_pos.y - home.y)
            if dist > 0.4:
                print(f"⚓ [Anchor Guardian] Drift detected ({dist:.2f}m > 0.4m). Snapping bot back to anchor: ({home.x:.1f}, {home.y:.1f}, {home.z:.1f})")
                write_system_log(f"Anchor Guardian: Snapped bot back to anchor (drift: {dist:.2f}m)")
                await bot.position_manager.ensure_home_position(bot)
