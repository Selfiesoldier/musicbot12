"""Economy manager for Music Bot - handles points, balances, and transactions"""

import json
import asyncio
import os
from pathlib import Path
from .point_packs import PointPacks
from core.logger import write_economy_log

class EconomyManager:
    """Manages user balances and point transactions"""
    
    # Command costs
    COMMAND_COSTS = {
        "play": 10,
        "next": 10,
        "clear_per_song": 20  # Quadrupled from original 5
    }
    
    # VIP clear command tracking (user_id: timestamp)
    vip_clear_usage = {}
    
    def __init__(self, balance_file="systems/economy/data/user_balances.json"):
        self.balance_file = balance_file
        self.balances = {}  # In-memory cache: {user_id: points}
        self.lock = asyncio.Lock()  # For thread-safe operations
        self.load_balances()
    
    def load_balances(self):
        """Load user balances from file"""
        try:
            if os.path.exists(self.balance_file):
                with open(self.balance_file, 'r') as f:
                    self.balances = json.load(f)
                print(f"✅ Loaded {len(self.balances)} user balances")
            else:
                self.balances = {}
                print("📝 Created new balance storage")
        except Exception as e:
            print(f"⚠️ Error loading balances: {e}")
            self.balances = {}
    
    def save_balances(self):
        """Save user balances to file"""
        try:
            # Ensure directory exists
            Path(self.balance_file).parent.mkdir(parents=True, exist_ok=True)
            
            with open(self.balance_file, 'w') as f:
                json.dump(self.balances, f, indent=2)
            return True
        except Exception as e:
            print(f"❌ Error saving balances: {e}")
            return False
    
    async def get_balance(self, user_id):
        """Get user's current balance"""
        async with self.lock:
            return self.balances.get(str(user_id), 0)
    
    async def add_points(self, user_id, amount, reason=""):
        """Add points to user's balance"""
        async with self.lock:
            user_id_str = str(user_id)
            current = self.balances.get(user_id_str, 0)
            self.balances[user_id_str] = current + amount
            self.save_balances()
            new_balance = self.balances[user_id_str]
            print(f"💰 Added {amount} points to user {user_id} ({reason}). New balance: {new_balance}")
            
            # Log the transaction
            write_economy_log(user_id, "add", amount, new_balance, reason)
            
            return new_balance
    
    async def deduct_points(self, user_id, amount, reason=""):
        """Deduct points from user's balance"""
        async with self.lock:
            user_id_str = str(user_id)
            current = self.balances.get(user_id_str, 0)
            
            if current < amount:
                return False, current  # Insufficient funds
            
            self.balances[user_id_str] = current - amount
            self.save_balances()
            new_balance = self.balances[user_id_str]
            print(f"💸 Deducted {amount} points from user {user_id} ({reason}). New balance: {new_balance}")
            
            # Log the transaction
            write_economy_log(user_id, "deduct", amount, new_balance, reason)
            
            return True, new_balance
    
    async def can_afford(self, user_id, amount):
        """Check if user can afford a command"""
        balance = await self.get_balance(user_id)
        return balance >= amount
    
    async def process_tip(self, user_id, gold_amount):
        """Process a gold tip and convert to points"""
        # Check if the gold amount matches any pack
        pack_id, pack = PointPacks.get_pack_by_gold(gold_amount)
        
        if pack:
            # Exact pack match - use pack points
            points = pack["points"]
            await self.add_points(user_id, points, f"Purchased {pack['name']}")
            return True, points, pack["name"]
        else:
            # Custom amount - use base conversion (10 gold = 50 points)
            points = (gold_amount // 10) * 50
            if points > 0:
                await self.add_points(user_id, points, f"Custom tip of {gold_amount} gold")
                return True, points, "Custom Pack"
            else:
                return False, 0, None
    
    async def check_and_deduct_command_cost(self, user_id, command, extra_data=None):
        """
        Check if user can afford a command and deduct the cost
        Returns: (success, new_balance, cost, message)
        """
        cost = 0
        
        if command == "play":
            cost = self.COMMAND_COSTS["play"]
        elif command == "dedicate":
            cost = self.COMMAND_COSTS["play"]  # Same cost as play
        elif command == "next":
            cost = self.COMMAND_COSTS["next"]
        elif command == "clear":
            # Cost depends on queue length
            queue_length = extra_data or 0
            cost = queue_length * self.COMMAND_COSTS["clear_per_song"]
        
        if cost == 0:
            return True, await self.get_balance(user_id), 0, ""
        
        can_afford = await self.can_afford(user_id, cost)
        
        if not can_afford:
            current_balance = await self.get_balance(user_id)
            shortage = cost - current_balance
            return False, current_balance, cost, f"Insufficient points! Need {cost} pts, you have {current_balance} pts (short by {shortage} pts)"
        
        # Deduct the cost
        success, new_balance = await self.deduct_points(user_id, cost, f"Used !{command}")
        return success, new_balance, cost, ""
    
    def get_command_cost(self, command, extra_data=None):
        """Get the cost of a command without deducting"""
        if command == "play":
            return self.COMMAND_COSTS["play"]
        elif command == "dedicate":
            return self.COMMAND_COSTS["play"]  # Same cost as play
        elif command == "next":
            return self.COMMAND_COSTS["next"]
        elif command == "clear":
            queue_length = extra_data or 0
            return queue_length * self.COMMAND_COSTS["clear_per_song"]
        return 0
    
    def can_vip_use_clear(self, user_id):
        """Check if VIP can use clear command (1 per hour limit)"""
        import time
        now = time.time()
        user_id_str = str(user_id)
        
        if user_id_str not in self.vip_clear_usage:
            return True, 0
        
        last_use = self.vip_clear_usage[user_id_str]
        time_since = now - last_use
        cooldown = 3600  # 1 hour in seconds
        
        if time_since >= cooldown:
            return True, 0
        
        remaining = cooldown - time_since
        return False, remaining
    
    def record_vip_clear(self, user_id):
        """Record that VIP used clear command"""
        import time
        self.vip_clear_usage[str(user_id)] = time.time()
