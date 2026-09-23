import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const names=fs.readdirSync(root).filter(x=>x.endsWith('.html'));
function fn(s,name){let start=s.indexOf('function '+name+'(');assert.ok(start>=0);return s.slice(start,s.indexOf('\n}',start)+2)}
for(const name of names){
 const s=fs.readFileSync(new URL(name,root),'utf8');
 test(name+' phone formats and inline syntax',()=>{
  for(const m of s.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  const context={};vm.createContext(context);vm.runInContext(fn(s,'agreementPhoneDigits'),context);
  for(const [input,expected] of [['+1 (202) 555-0123','12025550123'],['0012025550123','12025550123'],['12025550123','12025550123'],['+44 20 7946 0123','442079460123'],['0541234567','972541234567'],['03 5551234','97235551234'],['+972541234567','972541234567']])assert.equal(context.agreementPhoneDigits(input),expected,input);
  for(const bad of ['', '123', '+0123456789', 'abc0541234567','12+34567890','+1234567890123456','0000000000'])assert.equal(context.agreementPhoneDigits(bad),null,bad);
 });
 if(name!=='bsd-admin-prep.html')test(name+' actual form validation accepts international phone and still requires consent/signature',()=>{
  const nodes=new Map();const get=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='f_phone'?'+1 (202) 555-0123':id==='f_email'?'test@example.com':'Test',checked:true,style:{},classList:{add(){},remove(){},toggle(){}}});return nodes.get(id)};
  const c={document:{getElementById:get},hasSigned:true};vm.createContext(c);vm.runInContext(fn(s,'agreementPhoneDigits')+'\n'+fn(s,'validate'),c);
  assert.equal(c.validate(),true);
  get('f_phone').value='123';assert.equal(c.validate(),false);
  get('f_phone').value='0541234567';assert.equal(c.validate(),true);
  c.hasSigned=false;assert.equal(c.validate(),false);c.hasSigned=true;get('confirmCheck').checked=false;assert.equal(c.validate(),false);
  assert.ok(s.includes("p.get('clientPhone')"));
  assert.doesNotMatch(s,/f_phone'\)\.value\s*=\s*agreementPhoneDigits/);
 });
}
