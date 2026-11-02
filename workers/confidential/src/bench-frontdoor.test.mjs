import {test} from 'node:test';
import assert from 'node:assert/strict';
import {benchFrontdoor} from './bench-frontdoor.mjs';
const root='https://confidential.darius.life';
const env={BENCH_NOTES:{prepare(sql){assert.equal(sql,'SELECT share_number FROM docket_entries WHERE share_number = ?');return {bind(n){return {first:async()=>[1,2,6].includes(n)?{share_number:n}:null};}};}}};
test('each numbered envelope exposes only canonical number, identity and protected target',async()=>{
 for(const number of [1,2,6]){const label=String(number).padStart(3,'0');const r=await benchFrontdoor(new Request(root+'/note/'+label),env);const h=await r.text();assert.equal(r.status,200);assert(h.includes('og:title" content="Bench Note '+label));assert(h.includes('href="/bench/note/'+label+'"'));assert(h.includes('stenotype.jpg'));assert(!h.includes('case_id'));assert(!h.includes('shared_at'));assert(!h.includes('<script'));}
});
test('unknown notes are not invented',async()=>{assert.equal((await benchFrontdoor(new Request(root+'/note/999'),env)).status,404);assert.equal((await benchFrontdoor(new Request(root+'/note/000'),env)).status,404);});
test('root remains generic with safe case target and no token reflection',async()=>{for(const id of ['//evil.test','<script>','javascript:alert(1)']){const r=await benchFrontdoor(new Request(root+'/?case='+encodeURIComponent(id)+'&token=SECRET'));const h=await r.text();assert(h.includes('href="/bench/"'));assert(!h.includes('SECRET'));assert(!h.includes('evil.test'));}});
test('stylesheet respects strict same-origin CSP',async()=>{const r=await benchFrontdoor(new Request(root+'/'));const h=await r.text();assert(!h.includes('<style>'));assert(h.includes('/bench-frontdoor.css'));assert(r.headers.get('Content-Security-Policy').includes("style-src 'self'"));const css=await benchFrontdoor(new Request(root+'/bench-frontdoor.css'));assert((await css.text()).includes('#E9E0CC'));});
test('read-only frontdoor and bodyless HEAD',async()=>{assert.equal((await benchFrontdoor(new Request(root+'/',{method:'POST'}))).status,405);assert.equal(await(await benchFrontdoor(new Request(root+'/',{method:'HEAD'}))).text(),'');});
