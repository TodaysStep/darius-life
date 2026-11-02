const fail=(code,status=400)=>{throw Object.assign(new Error(code),{safeCode:code,status});};
export function checkedStorageOptions(options,operation){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype)fail('storage_options_invalid');
 const allowed=operation==='get'?['onlyIf','range']:operation==='put'?['onlyIf','httpMetadata','customMetadata']:['httpMetadata','customMetadata'];
 if(Object.keys(options).some(key=>!allowed.includes(key)))fail('storage_option_not_supported');
 if(options.onlyIf!==undefined){const c=options.onlyIf;if(!c||Object.getPrototypeOf(c)!==Object.prototype||Object.keys(c).some(k=>!['etagMatches','etagDoesNotMatch'].includes(k)||typeof c[k]!=='string'))fail('unsupported_condition');}
 if(options.range!==undefined){const r=options.range;if(!r||Object.getPrototypeOf(r)!==Object.prototype||Object.keys(r).some(k=>!['offset','length','suffix'].includes(k)||!Number.isSafeInteger(r[k])||r[k]<0))fail('invalid_range',416);}
 for(const name of ['httpMetadata','customMetadata'])if(options[name]!==undefined&&(!options[name]||Object.getPrototypeOf(options[name])!==Object.prototype))fail('storage_metadata_invalid');
 return options;
}
