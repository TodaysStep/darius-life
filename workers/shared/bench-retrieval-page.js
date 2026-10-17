// Cursor values are positions, not authorization. Callers must authenticate first.
export function literalPattern(value) { return '%'+String(value).slice(0,300).replace(/[\\%_]/g,'\\$&')+'%'; }
export function syntheticSourceSQL(value) {
 const normalized=`replace(replace(lower(COALESCE(${value},'')),'-','_'),' ','_')`;
 return `(${normalized} IN ('synthetic','fixture','test_fixture','test_data','test_record') OR ${normalized} GLOB 'synthetic_*' OR ${normalized} GLOB 'test_fixture_*')`;
}
export function realMetadataSQL(value) {
 const safe=`CASE WHEN json_valid(${value}) THEN ${value} ELSE '{}' END`;
 return `NOT EXISTS (SELECT 1 FROM json_tree(${safe}) provenance WHERE (provenance.key IN ('source','source_kind','source_class') AND ${syntheticSourceSQL('provenance.value')}) OR (provenance.key IN ('synthetic','is_synthetic','is_test') AND provenance.value=1))`;
}
export function readCursor(token,kind,filters) {
 if(!token)return null;
 try {
  if(typeof token!=='string'||token.length>5000)throw 0;
  const c=JSON.parse(decodeURIComponent(escape(atob(token))));
  if(c.v!==1||c.kind!==kind||c.query!==queryKey(filters)||typeof c.id!=='string'||c.id.length>300||typeof c.time!=='string'||c.time.length>100)throw 0;
  return c;
 }catch{throw new Error('invalid_cursor');}
}
function queryKey(filters) {return JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([k])=>!['cursor','note_cursor','limit'].includes(k)).sort(([a],[b])=>a.localeCompare(b))));}
export function finishPage(found,limit,kind,filters,timeField) {
 const items=found.slice(0,limit),last=items.at(-1),has_more=found.length>limit;
 const next_cursor=has_more?btoa(unescape(encodeURIComponent(JSON.stringify({v:1,kind,query:queryKey(filters),time:last[timeField],id:last.id})))):null;
 return {items,retrieval:{method:'literal_text_and_structured_filters',semantic:false,search_scope:'all_eligible_stored_text',originals_without_extracted_text_searchable:false,limit,has_more,next_cursor,complete_corpus:false,coverage_note:'All eligible stored text is searched before paging. A page is not a complete corpus export; unextracted originals and uncollected sources are outside text coverage.'}};
}
