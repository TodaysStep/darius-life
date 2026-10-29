import assert from 'node:assert/strict';
import {benchFrontdoor} from './bench-frontdoor.mjs';
let count=0;
const check=(a,b)=>{assert(a,b);count++;};
const base='https://confidential.darius.life/';
const res=benchFrontdoor(new Request(base));const html=await res.text();
check(res.status===200);check(!res.headers.has('Location'));check(html.includes('og:title'));check(html.includes('stenotype.jpg?v=20261004-3'));check(html.includes('href="/bench/"'));check(res.headers.get('Cache-Control')==='no-store');check(html.includes('noindex, nofollow'));
const id='00000000-0000-4000-8000-000000000001';
const note=await benchFrontdoor(new Request(base+'?case='+id)).text();check(note.includes('href="/bench/case/'+id+'"'));
for(const bad of ['https://evil.test','//evil.test','<script>alert(1)</script>',id+'/../../','javascript:alert(1)',id+'?token=secret']){const h=await benchFrontdoor(new Request(base+'?case='+encodeURIComponent(bad)+'&token=SECRET')).text();check(h.includes('href="/bench/"'));check(!h.includes('SECRET'));check(!h.includes('evil.test'));}
check(!note.includes('ADA'));check(!note.includes('26CU'));check(!note.includes('hardship'));check(!note.includes('script>'));check(!note.includes('http-equiv="refresh"'));
for(const method of ['POST','PUT','DELETE']) check(benchFrontdoor(new Request(base,{method})).status===405);
check((await benchFrontdoor(new Request(base,{method:'HEAD'})).text())==='');
console.log(count+' preview/privacy/routing checks passed');

const css=benchFrontdoor(new Request(base+'bench-frontdoor.css'));check(css.status===200);check(css.headers.get('Content-Type').startsWith('text/css'));check((await css.text()).includes('#E9E0CC'));check(html.includes('href="/bench-frontdoor.css?v=20261029"'));check(!html.includes('<style>'));check(res.headers.get('Content-Security-Policy').includes("style-src 'self'"));console.log(count+' total checks passed');
