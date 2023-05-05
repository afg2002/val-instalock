# pip install valclient 1st

from valclient.client import Client
from agent import Agent

agent = Agent()

client = Client(region="ap")
client.activate()

# get MatchID of current game

matchID = client.pregame_fetch_player()["MatchID"]

agentLock = client.pregame_lock_character(
    agent.Gekko(), match_id=matchID)
