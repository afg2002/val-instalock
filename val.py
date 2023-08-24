# pip install valclient 1st

from valclient.client import Client
import json

client = Client()
client = Client(region='eu')
client.activate()
with open('agents.json','r') as f:
    data = json.load(f)
    
agent = str(input('Agent name (Cap sensitive): '))

agentt = data[agent]

client.pregame_lock_character(agent_id=agentt)