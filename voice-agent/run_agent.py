"""
Auto-restart wrapper for the voice agent.
Keeps the agent running and restarts on crash.
"""
import subprocess
import sys
import time
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("agent-supervisor")

MAX_RESTARTS = 100
RESTART_DELAY = 2  # seconds

def run_agent():
    restarts = 0
    while restarts < MAX_RESTARTS:
        logger.info(f"Starting voice agent (attempt {restarts + 1})...")
        try:
            process = subprocess.run(
                [sys.executable, "simple_agent.py"],
                cwd=r"C:\Users\Admin\Desktop\CLAWDBOT\infinibot\voice-agent"
            )
            exit_code = process.returncode
            logger.warning(f"Agent exited with code {exit_code}")
        except KeyboardInterrupt:
            logger.info("Interrupted by user, exiting...")
            break
        except Exception as e:
            logger.error(f"Agent crashed: {e}")
        
        restarts += 1
        if restarts < MAX_RESTARTS:
            logger.info(f"Restarting in {RESTART_DELAY} seconds...")
            time.sleep(RESTART_DELAY)
    
    logger.error("Max restarts reached, giving up")

if __name__ == "__main__":
    run_agent()
