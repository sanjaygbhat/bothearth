import {readFileSync,writeFileSync} from 'node:fs';
import {request} from 'node:https';
import {spawnSync} from 'node:child_process';
import {ConnectorMcpClient} from '../../dist/mcp/client.js';
const [file,action,label]=process.argv.slice(2);const f=JSON.parse(readFileSync(file,'utf8'));
if(f.origin!=='https://localhost:7792'||!f.name.startsWith('native-'))throw new Error('Only the disposable native fixture is supported');
const call=(path,method='GET',body)=>new Promise((resolve,reject)=>{const req=request(f.origin+path,{family:4,ca:readFileSync(f.cert),method,headers:{Origin:f.origin,'Content-Type':'application/json',...f.headers}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>res.statusCode>=300?reject(new Error(path+':'+res.statusCode)):resolve(data?JSON.parse(data):{}))});req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body))});
if(action==='issue'){const result=await call('/api/v1/session/pairings','POST',{});writeFileSync(f.root+'/pairing.json',JSON.stringify(result),{mode:0o600});console.log(f.root+'/pairing.json');}
else if(action==='reset'){
 for(const t of (await call('/api/v1/tasks')).tasks)if(['running','paused'].includes(t.status))await call('/api/v1/tasks/'+t.id+'/cancel','POST',{});
 for(const lease of (await call('/api/v1/takeovers')).takeovers)if(lease.state==='human')await call('/api/v1/takeover/'+lease.id+'/release','POST',{});
 const mcp=await ConnectorMcpClient.connectHttp({url:f.target+'/mcp',headers:{Authorization:'Bearer '+f.mcpToken}});const result=await mcp.callTool('browser_navigate',{url:'http://127.0.0.1:8080',wait_until:'domcontentloaded'});await mcp.close();if(!JSON.parse(result.content[0].text).ok)throw new Error('Fixture reset failed');
}else if(action==='revoke'){
 const device=(await call('/api/v1/session/devices')).devices.filter(d=>d.label===label&&!d.current).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0];if(!device)throw new Error('Fixture device not found');await call('/api/v1/session/devices/'+device.id,'DELETE');console.log('Device revoked');
}else if(action==='verify'){
 const value=spawnSync('docker',['exec','modelbot-'+f.name+'-browser','node','-e',"fetch('http://127.0.0.1:8080/value').then(r=>r.text()).then(t=>process.stdout.write(t))"],{encoding:'utf8'});if(value.status!==0||value.stdout!==label)throw new Error('Remote DOM does not match committed native IME text');
 const leases=(await call('/api/v1/takeovers')).takeovers;if(!leases.some(l=>l.computer_id===f.name&&l.state==='human'))throw new Error('Native disconnect/revoke changed HUMAN lease');console.log('Exact remote IME text and retained HUMAN lease verified');
}else throw new Error('Use issue, reset, revoke <label>, or verify <expected-text>');
