import subprocess
import threading
import time
import os
import re
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Use Python 3.12 from venv
python_exe = r"C:\Users\sanif\OneDrive\Desktop\musicbot-main\venv312\Scripts\python.exe"

# Fallback if venv doesn't exist
if not os.path.exists(python_exe):
    python_exe = sys.executable
    print(f"[LAUNCHER] Warning: venv312 not found, using system Python: {python_exe}")
else:
    print(f"[LAUNCHER] Using Python 3.12 from venv: {python_exe}")

# Commands
CMD_SERVER = ["node", "--max-old-space-size=128", "--expose-gc", "server.js"]
CMD_TUNNEL = ["npx", "cloudflared", "tunnel", "--url", "http://localhost:5000"]
CMD_BOT = [python_exe, "-u", "main.py"]

# State
public_url = None
processes = {}

def tail_stream(prefix, stream, is_tunnel=False):
    global public_url
    try:
        for line in iter(stream.readline, b''):
            line_str = line.decode('utf-8', errors='replace').strip()
            if not line_str: continue
            
            # Print with prefix
            sys.stdout.write(f"{prefix} {line_str}\n")
            sys.stdout.flush()

            # Auto-extract cloudflare URL
            if is_tunnel and public_url is None:
                match = re.search(r'(https://[a-zA-Z0-9-]+\.trycloudflare\.com)', line_str)
                if match:
                    public_url = match.group(1)
                    print(f"\n[LAUNCHER] 🌐 Extracted Cloudflare URL: {public_url}")
                    print("[LAUNCHER] 🚀 Starting Python Bot...\n")
                    start_process("BOT", CMD_BOT, env_add={"PUBLIC_URL": public_url})
    except Exception as e:
        print(f"[LAUNCHER] Error reading stream for {prefix}: {e}")

def start_process(name, cmd, env_add=None):
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if env_add:
        env.update(env_add)

    prefix = f"[{name}]"
    print(f"[LAUNCHER] Starting {name} watchdog...")
    
    def watchdog():
        while True:
            print(f"[LAUNCHER] 🟢 Spawning {name}...")
            # Use shell=True for npx on Windows to resolve correctly
            p = subprocess.Popen(
                cmd, 
                env=env,
                stdout=subprocess.PIPE, 
                stderr=subprocess.STDOUT,
                shell=(name == "TUNNEL")
            )
            processes[name] = p
            
            # Read logs blocking
            tail_stream(prefix, p.stdout, is_tunnel=(name == "TUNNEL"))
            
            p.wait()
            print(f"[LAUNCHER] 🔴 {name} crashed or stopped! Restarting in 3 seconds...")
            time.sleep(3)

    t = threading.Thread(target=watchdog, daemon=True)
    t.start()

if __name__ == "__main__":
    print("==================================================")
    print("🎵 Highrise Music Bot - Ultimate Launcher 🎵")
    print("==================================================")
    
    start_process("SERVER", CMD_SERVER)
    start_process("TUNNEL", CMD_TUNNEL)
    
    # Bot starts automatically once TUNNEL finds the URL.
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[LAUNCHER] Shutting down all processes...")
        for name, p in processes.items():
            try:
                p.terminate()
            except:
                pass
        sys.exit(0)
