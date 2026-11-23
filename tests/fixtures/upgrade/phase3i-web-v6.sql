INSERT INTO agent_work_items(id,agent_id,source,source_key,effect_class,state,enqueued_at,ready_at,payload)
VALUES ('synthetic-delegation-work','bi','delegation','synthetic-delegation','write','succeeded',1,1,'{"kind":"delegation","task":"Synthetic historical task"}');
INSERT INTO delegations(id,work_id,parent_store,parent_session_id,parent_run_id,target_agent_id,request_key,request_hash,
  status,reserved_requests,reserved_tools,reserved_ms,created_at,finished_at,destination,result)
VALUES ('synthetic-delegation','synthetic-delegation-work','web','visible','synthetic-parent','bi','synthetic-key',lower(hex(zeroblob(32))),
  'succeeded',10,30,300000,1,2,'{"sessionId":"visible"}','{"delegationId":"synthetic-delegation","status":"succeeded"}');
INSERT INTO delegation_request_keys VALUES ('web','synthetic-parent','synthetic-key','synthetic-delegation');
PRAGMA user_version=6;
