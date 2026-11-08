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
const DEFAULT_CATS = ["Stadt","Land","Fluss","Tier","Name","Beruf"];
const ALLOWED_CATS = [...DEFAULT_CATS,"Essen","Getränk","Pflanze","Sportart","Film","Serie","Videospiel","Promi","Marke","Gegenstand","Hobby","Farbe","Musiker","Buch","Superheld","Schulfach","Berufsort"];
const LETTERS = "ABCDEFGHIJKLMNOPRSTUVW";
const code = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const clean = s => String(s || "").trim().slice(0,24);
// Online-Wortprüfung über Wikidata. Ergebnisse werden zwischengespeichert,
// damit dieselben Antworten nicht bei jeder Runde erneut abgefragt werden.
const wordCache = new Map();
const CATEGORY_HINTS = {
  "Stadt": /\b(stadt|city|gemeinde|municipality)\b/i,
  "Land": /\b(land|staat|country|sovereign state)\b/i,
  "Fluss": /\b(fluss|river|strom)\b/i,
  "Tier": /\b(tier|animal|säugetier|vogel|fisch|reptil|amphib)\b/i,
  "Beruf": /\b(beruf|occupation|profession|job)\b/i,
  "Essen": /\b(gericht|essen|lebensmittel|food|dish|fruit|vegetable)\b/i,
  "Getränk": /\b(getränk|drink|beverage)\b/i,
  "Pflanze": /\b(pflanze|plant|baum|blume)\b/i,
  "Sportart": /\b(sport|sportart|sport discipline)\b/i,
  "Film": /\b(film|movie)\b/i,
  "Serie": /\b(fernsehserie|tv series|television series)\b/i,
  "Videospiel": /\b(videospiel|video game)\b/i,
  "Promi": /\b(mensch|person|actor|schauspieler|musiker|athlet|politiker|singer)\b/i,
  "Marke": /\b(mark|brand|unternehmen|company)\b/i,
  "Farbe": /\b(farbe|color|colour)\b/i,
  "Musiker": /\b(musiker|musician|sänger|singer|komponist)\b/i,
  "Buch": /\b(buch|book|novel)\b/i,
  "Superheld": /\b(superheld|superhero|comic character)\b/i
};
async function isKnownAnswer(category, answer) {
  const value = String(answer || "").trim();
  if (value.length < 2 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(value)) return false;
  const key = category + "|" + value.toLocaleLowerCase("de-DE");
  if (wordCache.has(key)) return wordCache.get(key);
  try {
    const url = "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=" + encodeURIComponent(value) + "&language=de&uselang=de&format=json&limit=8";
    const response = await fetch(url, { headers: { "User-Agent": "GamingOnLife/1.0 (word validation)" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Wortdienst nicht erreichbar");
    const data = await response.json();
    const normalized = value.toLocaleLowerCase("de-DE");
    const exact = (data.search || []).filter(x => String(x.label || "").toLocaleLowerCase("de-DE") === normalized);
    let valid = exact.length > 0;
    const hint = CATEGORY_HINTS[category];
    if (valid && hint) valid = exact.some(x => hint.test((x.description || "") + " " + (x.label || "")));
    wordCache.set(key, valid);
    return valid;
  } catch (e) {
    // Bei Ausfall der Online-Prüfung keine automatische Freigabe: Host kann korrigieren.
    return false;
  }
}

function pubRoom(r) {
  return { code:r.code, hostId:r.hostId, status:r.status, round:r.round, letter:r.letter,
    endsAt:r.endsAt, players:[...r.players.values()].map(p=>({id:p.id,name:p.name,score:p.score,host:p.id===r.hostId,ready:p.ready,finished:!!p.finished})),
    maxPlayers:20, duration:r.duration, totalRounds:r.totalRounds, categories:r.categories, finished:r.status==="finished" };
}
function emitRoom(r) { io.to(r.code).emit("room:update", pubRoom(r)); }
function err(s,msg){s.emit("app:error",msg);}
function stopTimer(r){ if(r.timer){clearTimeout(r.timer);r.timer=null;} }
async function endRound(r){
  if(r.status!=="playing") return;
  stopTimer(r); r.status="checking";
  const entries=[...r.players.values()];
  const count={};
  for(const p of entries) for(const c of r.categories){const v=(p.answers[c]||"").trim();if(v){const k=c+"|"+v.toLocaleLowerCase("de-DE");count[k]=(count[k]||0)+1;}}
  const checked = await Promise.all(entries.map(async p=>{
    const details={}; let total=0;
    for(const c of r.categories){const v=(p.answers[c]||"").trim();const starts=!!v && v.toLocaleUpperCase("de-DE").startsWith(r.letter);
      const exists=starts ? await isKnownAnswer(c,v) : false; const valid=starts && exists;
      const pts=!valid?0:(count[c+"|"+v.toLocaleLowerCase("de-DE")] > 1 ? 10:20);
      details[c]={answer:v,points:pts,valid,needsReview:starts&&!exists}; total+=pts;
    }
    return {id:p.id,name:p.name,details,points:total};
  }));
  r.roundResults=checked; r.status="review";
  for(const result of r.roundResults){const p=r.players.get(result.id);if(p)p.score+=result.points;}
  emitRoom(r); io.to(r.code).emit("round:results",r.roundResults);
}
io.on("connection", socket=>{
  socket.on("rooms:list",()=>{
    socket.emit("rooms:list", [...rooms.values()].filter(r=>r.status!=="closed").map(r=>({code:r.code,count:r.players.size,status:r.status,round:r.round})));
  });
  socket.on("room:create",({name,duration,totalRounds,categories},cb)=>{
    name=clean(name); if(!name)return cb?.({error:"Bitte gib einen Spielernamen ein."});
    let c; do{c=code();}while(rooms.has(c));
    const r={code:c,hostId:socket.id,status:"lobby",round:0,letter:null,endsAt:null,duration:[60,90,120].includes(+duration)?+duration:90,totalRounds:[3,5,10,15].includes(+totalRounds)?+totalRounds:5,categories:Array.isArray(categories)?ALLOWED_CATS.filter(c=>categories.includes(c)):DEFAULT_CATS,players:new Map(),timer:null,roundResults:[]};
    r.players.set(socket.id,{id:socket.id,name,score:0,answers:{},ready:true});
    rooms.set(c,r);socket.join(c);cb?.({room:pubRoom(r)});emitRoom(r);
  });
  socket.on("room:join",({code:raw,name},cb)=>{
    const c=String(raw||"").trim().toUpperCase(),name2=clean(name),r=rooms.get(c);
    if(!r)return cb?.({error:"Raum nicht gefunden. Prüfe den Code."});
    if(!name2)return cb?.({error:"Bitte gib einen Spielernamen ein."});
    if(r.status==="playing"||r.status==="checking"||r.status==="review")return cb?.({error:"Die Runde läuft bereits. Beitritt ist gerade gesperrt."});
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
    if(r.status==="finished")return cb?.({error:"Das Spiel ist bereits beendet. Erstelle einen neuen Raum."});
    if(r.round>=r.totalRounds)return cb?.({error:"Alle Runden sind bereits gespielt."});
    if(r.status==="playing")return cb?.({error:"Eine Runde läuft bereits."});
    r.round++;r.status="playing";r.letter=LETTERS[Math.floor(Math.random()*LETTERS.length)];
    r.roundResults=[];for(const p of r.players.values()){p.answers={};p.finished=false;}
    r.endsAt=Date.now()+r.duration*1000;stopTimer(r);r.timer=setTimeout(()=>endRound(r),r.duration*1000);
    emitRoom(r);io.to(r.code).emit("game:started",{round:r.round,letter:r.letter,endsAt:r.endsAt});cb?.({ok:true});
  });
  socket.on("answers:save",({code:c,answers},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase()),p=r?.players.get(socket.id);
    if(!r||!p||r.status!=="playing")return cb?.({error:"Gerade läuft keine Runde."});
    if(p.finished)return cb?.({error:"Du bist bereits fertig und kannst nichts mehr ändern."});
    const next={};for(const cat of r.categories)next[cat]=clean(answers?.[cat]||"").slice(0,50);
    p.answers=next;cb?.({ok:true});
  });
  socket.on("answers:finish",({code:c,answers},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase()),p=r?.players.get(socket.id);
    if(!r||!p||r.status!=="playing")return cb?.({error:"Gerade läuft keine Runde."});
    if(p.finished)return cb?.({ok:true,finished:true});
    const next={};for(const cat of r.categories)next[cat]=clean(answers?.[cat]||"").slice(0,50);
    p.answers=next;p.finished=true;emitRoom(r);cb?.({ok:true,finished:true});
  });
  socket.on("game:finish",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host kann die Runde beenden."});
    endRound(r);cb?.({ok:true});
  });
  socket.on("score:adjust",({code:c,playerId,category,delta},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());
    if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host darf Punkte ändern."});
    if(r.status!=="review")return cb?.({error:"Punkte können nur in der Auswertung geändert werden."});
    if(![10,-10].includes(Number(delta))||!r.categories.includes(category))return cb?.({error:"Ungültige Punkteänderung."});
    const result=r.roundResults.find(x=>x.id===playerId);
    const player=r.players.get(playerId);
    if(!result||!player||!result.details[category])return cb?.({error:"Antwort nicht gefunden."});
    const detail=result.details[category];
    const change=Number(delta);
    if(change<0 && detail.points<=0)return cb?.({error:"Hier können keine weiteren Punkte abgezogen werden."});
    detail.points+=change; result.points+=change; player.score+=change;
    emitRoom(r); io.to(r.code).emit("round:results",r.roundResults); cb?.({ok:true});
  });
  socket.on("game:next",({code:c},cb)=>{
    const r=rooms.get(String(c||"").toUpperCase());if(!r||r.hostId!==socket.id)return cb?.({error:"Nur der Host kann die nächste Runde starten."});
    if(r.status!=="review")return cb?.({error:"Die Auswertung ist noch nicht fertig."});
    if(r.round>=r.totalRounds){r.status="finished";emitRoom(r);cb?.({ok:true,finished:true});return;}
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
