/**
 * Marketing-site client scripts (CCB-S3-001) — vanilla ports of the template's
 * React effects, emitted inline under the per-response CSP nonce (no external
 * scripts, no framework). Everything degrades gracefully: without JS the page is
 * fully rendered (SSR), reveal targets stay visible via the `.no-js` rule, and
 * the archive demo simply shows all sample rows.
 */

/** No-flash theme boot (head): dark is default; 'light' persisted in `cn-theme`. */
export function themeBootScript(lightColor: string): string {
  return (
    `(function(){document.documentElement.className='js';` +
    `try{var t=localStorage.getItem('cn-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');` +
    `var m=document.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content','${lightColor}');}}catch(e){}})();`
  );
}

/** Header chrome: theme toggle + mobile burger menu. */
export function chromeScript(lightColor: string, darkColor: string): string {
  return `(function(){
var tb=document.getElementById('cn-theme-toggle');
if(tb)tb.addEventListener('click',function(){
  var light=document.documentElement.getAttribute('data-theme')==='light';
  if(light)document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme','light');
  try{localStorage.setItem('cn-theme',light?'dark':'light');}catch(e){}
  var m=document.querySelector('meta[name=theme-color]');
  if(m)m.setAttribute('content',light?'${darkColor}':'${lightColor}');
});
var bg=document.getElementById('cn-burger'),mm=document.getElementById('cn-mobile-menu');
if(bg&&mm)bg.addEventListener('click',function(){
  var open=!mm.hasAttribute('hidden');
  if(open){mm.setAttribute('hidden','');bg.classList.remove('open');}
  else{mm.removeAttribute('hidden');bg.classList.add('open');}
  bg.setAttribute('aria-expanded',open?'false':'true');
});
})();`;
}

/** Twinkling multi-colour starfield (white / cyan / magenta), honors reduced motion. */
export const STARFIELD_SCRIPT = `(function(){
var cv=document.getElementById('cn-starfield');if(!cv)return;
var ctx=cv.getContext('2d');if(!ctx)return;
var DPR=Math.min(window.devicePixelRatio||1,2);
var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
var palette=[[255,255,255],[141,225,236],[244,92,176]];
var w,h,stars=[],raf,t=0;
function build(){
  w=innerWidth;h=innerHeight;cv.width=w*DPR;cv.height=h*DPR;ctx.setTransform(DPR,0,0,DPR,0,0);
  var n=Math.min(190,Math.floor(w*h/9000));
  stars=[];
  for(var i=0;i<n;i++){var r=Math.random();var ci=r<0.72?0:r<0.9?1:2;
    stars.push({x:Math.random()*w,y:Math.random()*h,r:Math.random()*1.3+0.35,c:palette[ci],ph:Math.random()*6.283,sp:0.5+Math.random()*1.7,base:0.3+Math.random()*0.5});}
}
build();addEventListener('resize',build);
function draw(){
  ctx.clearRect(0,0,w,h);
  for(var i=0;i<stars.length;i++){var s=stars[i];
    var a=reduce?s.base:Math.max(0,Math.min(1,s.base+Math.sin(t*s.sp+s.ph)*0.4));
    ctx.fillStyle='rgba('+s.c[0]+','+s.c[1]+','+s.c[2]+','+a+')';
    ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,6.283);ctx.fill();
    if(s.r>1){ctx.fillStyle='rgba('+s.c[0]+','+s.c[1]+','+s.c[2]+','+(a*0.25)+')';
      ctx.beginPath();ctx.arc(s.x,s.y,s.r*2.8,0,6.283);ctx.fill();}}
}
function frame(){t+=0.016;draw();raf=requestAnimationFrame(frame);}
if(reduce)draw();else frame();
})();`;

/** Scroll reveals for [data-reveal] sections. */
export const REVEAL_SCRIPT = `(function(){
if(!('IntersectionObserver' in window))return;
var io=new IntersectionObserver(function(es){es.forEach(function(en){
  if(en.isIntersecting){en.target.classList.add('on');io.unobserve(en.target);}});},{threshold:.12});
document.querySelectorAll('[data-reveal]:not(.on)').forEach(function(el){io.observe(el);});
})();`;

export interface DemoMessage {
  g: string;
  a: string;
  t: string;
  text: string;
  media?: 'file' | 'video' | 'image';
}

export interface DemoConfig {
  messages: DemoMessage[];
  groups: string[];
  word: string;
  i18n: {
    messages: string;
    of: string;
    empty: string;
    archived: string;
    attachment: string;
  };
  /** Inline SVG markup for the client-rendered rows (check/lock/media icons). */
  icons: Record<string, string>;
}

/** The interactive archive demo (search + filters + typing animation). */
export function archiveDemoScript(cfg: DemoConfig): string {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `(function(){
var CFG=${json};
var root=document.getElementById('cn-ad');if(!root)return;
var input=document.getElementById('cn-ad-input');
var clearBtn=document.getElementById('cn-ad-clear');
var stream=document.getElementById('cn-ad-stream');
var empty=document.getElementById('cn-ad-empty');
var countEl=document.getElementById('cn-ad-count');
var urlEl=document.getElementById('cn-ad-url-group');
var mediaBtn=document.getElementById('cn-ad-media');
if(!input||!stream||!countEl)return;
var q='',group='all',mediaOnly=false,interacted=false;
function esc(s){return s.replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function hl(text){
  if(!q)return esc(text);
  var e=q.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&');
  var parts=text.split(new RegExp('('+e+')','ig'));
  var out='';
  for(var i=0;i<parts.length;i++){
    if(parts[i].toLowerCase()===q.toLowerCase()&&parts[i])out+='<mark class="ad-hl">'+esc(parts[i])+'</mark>';
    else out+=esc(parts[i]);
  }
  return out;
}
function rows(){
  return CFG.messages.filter(function(m){
    return (group==='all'||m.g===group)&&(!mediaOnly||m.media)&&
      (!q||(m.text+' '+m.a+' '+m.g).toLowerCase().indexOf(q.toLowerCase())>=0);
  });
}
var MEDIA_ICON={file:'file-text',video:'clapperboard',image:'image'};
function mediaChip(m){
  if(!m.media)return '';
  var label=m.media==='file'?CFG.i18n.attachment:(m.media==='video'?'video · behind auth':'image · behind auth');
  return '<div class="ad-chip">'+CFG.icons[MEDIA_ICON[m.media]]+'<span>'+esc(label)+'</span>'+CFG.icons.lock+'</div>';
}
function render(){
  var rs=rows();
  var htmlOut='';
  for(var i=0;i<rs.length;i++){var m=rs[i];
    htmlOut+='<div class="ad-msg"><span class="ad-avatar" aria-hidden="true">'+esc(m.a[0].toUpperCase())+'</span>'+
      '<div style="flex:1;min-width:0"><div class="ad-meta"><b>'+hl(m.a)+'</b><span class="ad-grp">'+hl(m.g)+'</span>'+
      '<span class="ad-time">'+esc(m.t)+'</span><span class="ad-arch">'+CFG.icons.check+esc(CFG.i18n.archived)+'</span></div>'+
      '<div class="ad-text">'+hl(m.text)+'</div>'+mediaChip(m)+'</div></div>';
  }
  stream.innerHTML=htmlOut;
  if(empty){
    if(rs.length===0){empty.style.display='flex';var qe=document.getElementById('cn-ad-empty-q');if(qe)qe.textContent='\\u201C'+q+'\\u201D.';}
    else empty.style.display='none';
  }
  var total=CFG.messages.length;
  var base=rs.length===total?CFG.i18n.messages.replace('{n}',String(total)):CFG.i18n.of.replace('{n}',String(rs.length)).replace('{total}',String(total));
  countEl.innerHTML=esc(base)+(q?' <span style="color:var(--text-accent)">· \\u201C'+esc(q)+'\\u201D</span>':'');
  if(clearBtn)clearBtn.style.display=q?'inline-flex':'none';
  if(urlEl)urlEl.textContent=group==='all'?urlEl.getAttribute('data-all'):group;
  root.querySelectorAll('.ad-g').forEach(function(b){
    b.classList.toggle('on',b.getAttribute('data-group')===group);
  });
  if(mediaBtn){mediaBtn.classList.toggle('cn-tag-selected',mediaOnly);mediaBtn.setAttribute('aria-pressed',mediaOnly?'true':'false');}
}
function stop(){interacted=true;}
root.querySelectorAll('.ad-g').forEach(function(b){
  b.addEventListener('click',function(){stop();group=b.getAttribute('data-group');render();});
});
if(mediaBtn)mediaBtn.addEventListener('click',function(){stop();mediaOnly=!mediaOnly;render();});
input.addEventListener('input',function(){stop();q=input.value;render();});
input.addEventListener('focus',stop);
if(clearBtn)clearBtn.addEventListener('click',function(){stop();q='';input.value='';render();input.focus();});
render();
if(!matchMedia('(prefers-reduced-motion: reduce)').matches){
  var timers=[],word=CFG.word;
  function type(i){if(interacted)return;q=word.slice(0,i);input.value=q;render();
    if(i<word.length)timers.push(setTimeout(function(){type(i+1);},150));
    else timers.push(setTimeout(function(){del(word.length);},1600));}
  function del(i){if(interacted)return;q=word.slice(0,i);input.value=q;render();
    if(i>0)timers.push(setTimeout(function(){del(i-1);},80));}
  timers.push(setTimeout(function(){type(1);},900));
}
})();`;
}
