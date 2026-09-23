/** @param {import('../../shared/types').WindowSize} start @param {number} actualHeight @param {number} dx @param {number} dy */
export function resizeFromPointer(start, actualHeight, dx, dy) {
 return {width:Math.max(280,Math.min(800,start.width+dx)),height:dy===0?start.height:Math.max(56,actualHeight+dy)};
}

/** Serialize applies and terminal actions so a slow IPC cannot overwrite a newer size.
 * @param {(command:string,args?:Record<string,unknown>)=>Promise<unknown>} invoke */
export function createSizeController(invoke) {
 let tail=Promise.resolve();
 /** @param {string} command @param {Record<string,unknown>} [args] */
 function enqueue(command,args){const result=tail.then(()=>invoke(command,args)).then(()=>{});tail=result.catch(()=>{});return result;}
 return {
  /** @param {import('../../shared/types').WindowSize} size */
  preview:(size)=>enqueue('dock_set_size',{...size}),
  commit:()=>enqueue('dock_commit_size'),
  cancel:()=>enqueue('dock_cancel_size'),
  flush:()=>tail,
 };
}
