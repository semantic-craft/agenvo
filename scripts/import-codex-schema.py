"""Freeze baseline 0.160.1 schemas plus unsubscribe from 0.163.0.
Usage: import-codex-schema.py BASELINE_0_160_1 UNSUBSCRIBE_0_163_0
"""
import json, pathlib, sys
if len(sys.argv) != 3:
 raise SystemExit("usage: import-codex-schema.py BASELINE_0_160_1 UNSUBSCRIBE_0_163_0")
source = pathlib.Path(sys.argv[1])
unsubscribe_source = pathlib.Path(sys.argv[2])
methods = {
 'model/list': ('ModelListParams', None),
 'thread/loaded/list': ('ThreadLoadedListParams', None),
 'thread/start': ('ThreadStartParams', ['model','modelProvider','cwd','approvalPolicy','approvalsReviewer','sandbox','config','baseInstructions','developerInstructions','ephemeral','historyMode']),
 'thread/resume': ('ThreadResumeParams', ['threadId','model','modelProvider','cwd','approvalPolicy','approvalsReviewer','sandbox','config','baseInstructions','developerInstructions','excludeTurns','initialTurnsPage']),
 'thread/read': ('ThreadReadParams', None), 'thread/list': ('ThreadListParams', None), 'thread/archive': ('ThreadArchiveParams', None),
 'thread/turns/list': ('ThreadTurnsListParams', None), 'thread/items/list': ('ThreadItemsListParams', None),
 'turn/start': ('TurnStartParams', ['threadId','input','cwd','approvalPolicy','approvalsReviewer','sandboxPolicy','model','effort','summary','outputSchema']),
 'thread/unsubscribe': ('ThreadUnsubscribeParams', None),
 'thread/unarchive': ('ThreadUnarchiveParams', None),
 'turn/steer': ('TurnSteerParams', ['threadId','expectedTurnId','input']),
 'turn/interrupt': ('TurnInterruptParams', None),
}
responses = {'item/commandExecution/requestApproval':'CommandExecutionRequestApprovalResponse','item/fileChange/requestApproval':'FileChangeRequestApprovalResponse','item/permissions/requestApproval':'PermissionsRequestApprovalResponse','item/tool/requestUserInput':'ToolRequestUserInputResponse','item/tool/call':'DynamicToolCallResponse'}
def read(name, root=source):
 p=root/'v2'/(name+'.json')
 if not p.exists(): p=root/(name+'.json')
 data=json.loads(p.read_text());data['additionalProperties']=False
 return data
out={}
for method,(name,fields) in methods.items():
 d=read(name, unsubscribe_source if method == "thread/unsubscribe" else source)
 if fields: d['properties']={k:v for k,v in d['properties'].items() if k in fields}
 # Keep only definitions reachable from the approved properties.
 needed=set()
 def refs(node):
  if isinstance(node,dict):
   if '$ref' in node:
    key=node['$ref'].split('/')[-1]
    if key not in needed: needed.add(key);refs(d.get('definitions',{}).get(key,{}))
   for k,v in node.items():
    if k!='definitions': refs(v)
  elif isinstance(node,list):
   for v in node:refs(v)
 refs(d);d['definitions']={k:v for k,v in d.get('definitions',{}).items() if k in needed}
 out[method]=d
pathlib.Path('apps/codex-app-server/src/schema/codex.json').write_text(json.dumps({'version':'0.160.1','methodSources':{'thread/unsubscribe':'Codex CLI 0.163.0 generate-json-schema --experimental'},'methods':out,'responses':{k:read(v) for k,v in responses.items()}},indent=2)+'\n')
