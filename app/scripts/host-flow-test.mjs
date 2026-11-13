import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
const base=process.env.BASE || 'http://localhost:3210';
const socket=io(base); const player=io(base);
const event=(client,name)=>new Promise((resolve,reject)=>{client.once(name,resolve);setTimeout(()=>reject(Error('Timeout '+name)),5000).unref()});
try{
 await event(socket,'connect');
 const fail=event(socket,'host:error');socket.emit('host:create',{listId:'rock'});assert.match(await fail,/chanson/);
 const created=event(socket,'host:created');socket.emit('host:create',{listId:'disney',rounds:3});const room=await created;assert.equal(room.rounds,3);assert.ok(room.qr.startsWith('data:image/png'));assert.ok(room.joinUrl.includes('code='+room.code));
 const joined=await new Promise(r=>player.emit('player:join',{code:room.code,name:'Validation'},r));assert.equal(joined.ok,true);
 const closed=event(player,'room:closed');socket.emit('host:leave');await closed;
 const next=event(socket,'host:created');socket.emit('host:create',{listId:'disney',rounds:10});assert.equal((await next).rounds,10);
 console.log('OK empty list rejected; 3/10 rounds; QR; player join; change universe');
}finally{socket.disconnect();player.disconnect()}
