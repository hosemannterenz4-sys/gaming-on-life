const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req,res)=>res.json({ok:true, service:"Gaming On Life"}));

const rooms = new Map();
const CATS = ["Stadt","Land","Fluss","Tier","Name","Beruf"];
const LETTERS = "ABCDEFGHIJKLMNOPRSTUVW";
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const clean = s => String(s || "").trim().slice(0,24);
function pubRoom(r) {
  return { code:r.code, hostId:r.hostId, status:r.status, round:r.round, letter:r.letter,
    endsAt:r.endsAt, players:[...r.players.values()].map(p=>({id:p.id,name:p.name,score:p.score,host:p.id===r.hostId,ready:p.ready})),
    maxPlayers:20, duration:r.duration };
}
function emitRoom(r) { io.to(r.code).emit("room:update", pubRoom(r)); }
function err(s,msg){s.emit("app:error",msg);}
function stopTimer(r){ if(r.timer){clearTimeout(r.timer);r.timer=null;} }
function endRound(r){
  if(r.status!=="playing") return;
  stopTimer(r); r.status="review";
  const entries=[...r.players.values()];
  const count={};
  for(const p of entries) for(const c of CATS){const v=(p.answers[c]||"").trim();if(v){const k=c+"|"+v.toLocaleLowerCase("de-DE");count[k]=(count[k]||0)+1;}}
  r.roundResults=entries.map(p=>{
    const details={}; let total=0;
    for(const c of CATS){const v=(p.answers[c]||"").trim();const valid=!!v && v.toLocaleUpperCase("de-DE").startsWith(r.letter);
      const pts=!valid?0:(count[c+"|"+v.toLocaleLowerCase("de-DE")] > 1 ? 10:20);
      details[c]={answer:v,points:pts,valid}; total+=pts;
    }
    return {id:p.id,name:p.name,details,points:total};
  });
  for(const result of r.roundResults){const p=r.players.get(result.id);if(p)p.score+=result.points;}
  emitRoom(r); io.to(r.code).emit("round:results",r.roundResults);
}
io.on("connection", socket=>{
  socket.on("rooms:list",()=>{
    socket.emit("rooms:list", [...rooms.values()].filter(r=>r.status!=="closed").map(r=>({code:r.code,count:r.players.size,status:r.status,round:r.round})));
  });
  socket.on("room:create",({name,duration},cb)=>{
    name=clean(name); if(!name)return cb?.({error:"Bitte gib einen Spielernamen ein."});
    let c; do{c=code();}while(rooms.has(c));
    const r={code:c,hostId:socket.id,status:"lobby",round:0,letter:null,endsAt:null,duration:[60,90,120].includes(+duration)?+duration:90,players:new Map(),timer:null,roundResults:[]};
    r.players.set(socket.id,{id:socket.id,name,score:0,answers:{},ready:true});
    rooms.set(c,r);socket.join(c);cb?.({room:pubRoom(r)});emitRoom(r);
  });
  socket.on("room:join",({code:raw,name},cb)=>{
    const c=String(raw||"").trim().toUpperCase(),name2=clean(name),r=rooms.get(c);
    if(!r)return cb?.({error:"Raum nicht gefunden. Prüfe den Code."});
    if(!name2)return cb?.({error:"Bitte gib einen Spielernamen ein."});
    if(r.status==="playing"||r.status==="review")return cb?.({error:"Die Runde läuft bereits. Beitritt ist gerade gesperrt."});
    if(r.players.size>=20)return cb?.({error:"Der Raum ist voll (max. 20 Spieler)."});
    if([...r.players.values()].some(p=>p.name.toLowerCase()===name2.toLowerCase()))return cb?.({error:"Der Name ist in diesem Raum bereits vergeben."});
    r.players.set(socket.id,{id:socket.id,name:name2,score:0,answers:{},ready:true});socket.join(c);
    cb?.({room:pubRoom(r)});emitRoom(r);
  });
  socket.on("room:rejoin",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase()); if(!r||!r.players.has(socket.id))return cb?.({error:"Sitzung nicht gefunden. Bitte erneut beitreten."});
    socket.join(r.code);cb?.({room:pubRoom(r)});emitRoom(r);
  });
  socket.on("game:start",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host kann starten."});
    if(r.players.size<1)return cb?.({error:"Mindestens ein Spieler wird benötigt."});
    if(r.status==="playing")return cb?.({error:"Eine Runde läuft bereits."});
    r.round++;r.status="playing";r.letter=LETTERS[Math.floor(Math.random()*LETTERS.length)];
    r.roundResults=[];for(const p of r.players.values())p.answers={};
    r.endsAt=Date.now()+r.duration*1000;stopTimer(r);r.timer=setTimeout(()=>endRound(r),r.duration*1000);
    emitRoom(r);io.to(r.code).emit("game:started",{round:r.round,letter:r.letter,endsAt:r.endsAt});cb?.({ok:true});
  });
  socket.on("answers:save",({code:c,answers},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase()),p=r?.players.get(socket.id);
    if(!r||!p||r.status!=="playing")return cb?.({error:"Gerade läuft keine Runde."});
    const next={};for(const cat of CATS)next[cat]=clean(answers?.[cat]||"").slice(0,50);
    p.answers=next;cb?.({ok:true});
  });
  socket.on("game:finish",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host kann die Runde beenden."});
    endRound(r);cb?.({ok:true});
  });
  socket.on("game:next",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host kann die nächste Runde starten."});
    if(r.status!=="review")return cb?.({error:"Die Auswertung ist noch nicht fertig."});
    r.status="lobby";r.letter=null;r.endsAt=null;emitRoom(r);cb?.({ok:true});
  });
  socket.on("disconnect",()=>{
    for(const r of rooms.values()){
      if(r.players.has(socket.id)){
        r.players.delete(socket.id);
        if(r.players.size===0){stopTimer(r);rooms.delete(r.code);continue;}
        if(r.hostId===socket.id){r.hostId=r.players.keys().next().value;io.to(r.code).emit("notice","Der Host ist gegangen. Ein neuer Host wurde bestimmt.");}
        emitRoom(r);
      }
    }
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,"0.0.0.0",()=>console.log(`Gaming On Life läuft auf Port ${PORT}`));
