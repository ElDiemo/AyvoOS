"""Entry point: python3 -m ayvo_print_agent --config /etc/ayvo-print-agent/config.json"""

import argparse
import logging
from pathlib import Path

from .agent import Agent, Config


def main() -> None:
    parser = argparse.ArgumentParser(description="AYVO print agent (doc 030)")
    parser.add_argument("--config", default="/etc/ayvo-print-agent/config.json", type=Path)
    parser.add_argument("--once", action="store_true", help="one round (heartbeat + at most one job)")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    agent = Agent(Config.load(args.config))
    if args.once:
        agent.heartbeat(force=True)
        agent.once()
    else:
        agent.run_forever()


if __name__ == "__main__":
    main()
