import struct,pathlib

def action(code,data=b''):
 return bytes([code])+(struct.pack('<H',len(data))+data if code>=128 else b'')
def push(value):
 p=(b'\x00'+value.encode()+b'\x00') if isinstance(value,str) else b'\x07'+struct.pack('<i',value)
 return action(0x96,p)
def tag(kind,body=b''):
 return struct.pack('<H',(kind<<6)|len(body))+body if len(body)<63 else struct.pack('<HI',(kind<<6)|63,len(body))+body
bits='01100'+''.join(format(x,'012b') for x in [0,2000,0,2000]);bits+='0'*((-len(bits))%8)
rect=int(bits,2).to_bytes(len(bits)//8,'big')
fn=push('counter')+push('counter')+action(0x1c)+push(1)+action(0x47)+action(0x1d)
fn+=push('counter')+action(0x1c)+action(0x26)
fn+=push('timer:')+action(0x34)+action(0x47)+action(0x26)+b'\x00'
code=push('counter')+push(0)+action(0x1d)
code+=push('onEnterFrame')+action(0x9b,b'\x00'+struct.pack('<HH',0,len(fn)))+fn+action(0x1d)+action(0x07)+b'\x00'
body=rect+struct.pack('<HH',35*256,1)+tag(9,b'\xff\xff\xff')+tag(12,code)+tag(1)+tag(0)
pathlib.Path(__file__).with_name('clock-probe.swf').write_bytes(b'FWS\x08'+struct.pack('<I',len(body)+8)+body)
