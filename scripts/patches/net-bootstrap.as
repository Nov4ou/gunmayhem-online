// Netplay changes only the input and random sources. The original movie drives every frame.
_root.__netSeed = 1;
_root.__netFrame = -1;
_root.__netTicks = 0;
_root.__netStarted = false;
_root.__netMasks = [0,0,0,0];
_root.__netControls = [[38,37,40,39,219,221],[87,65,83,68,84,89],[111,103,104,105,106,109],[101,97,98,99,96,110]];
_root.__netFloat = function()
{
   _root.__netSeed = (_root.__netSeed * 16807) % 2147483647;
   return (_root.__netSeed - 1) / 2147483646;
};
_global.__gmRandom = function(n)
{
   return Math.floor(_root.__netFloat() * int(n));
};
ASSetPropFlags(Math,"random",0,4);
Math.random = _root.__netFloat;
ASSetPropFlags(Key,"isDown",0,4);
Key.isDown = function(code)
{
   var p = 0;
   while(p < 4)
   {
      var k = 0;
      while(k < 6)
      {
         if(_root.__netControls[p][k] == code)
         {
            return (_root.__netMasks[p] & (1 << k)) != 0;
         }
         k++;
      }
      p++;
   }
   return false;
};
_root.netInput = function(frame,masks)
{
   _root.__netFrame = Number(frame);
   var p = 0;
   while(p < 4)
   {
      _root.__netMasks[p] = Number(masks[p]) & 63;
      p++;
   }
   return true;
};
_root.__netInt = function(value, fallback, low, high)
{
   var n = Number(value);
   if(isNaN(n) || value == undefined) return fallback;
   return Math.max(low,Math.min(high,Math.floor(n)));
};
_root.netStart = function(config)
{
   if(_root.__netStarted) return false;
   _root.__netStarted = true;
   _root.__netSeed = _root.__netInt(config.seed,1,1,2147483646);
   _root.__netFrame = -1;
   _root.__netTicks = 0;
   _root.__netMasks = [0,0,0,0];
   _root.savedata2 = {data:{filled:true,musicON:true,soundON:true,def_quality:2,controlarray:_root.__netControls}};
   _root.savedata3 = {data:{filled:true,gunarray:[]}};
   var idx = 0;
   while(idx < 57) { _root.savedata3.data.gunarray[idx] = true; idx++; }
   var locked = [18,19,20,21,22,29,30,31,32,33,40,41,42,43,44,52,53,54,55,56];
   idx = 0;
   while(idx < locked.length) { _root.savedata3.data.gunarray[locked[idx]] = false; idx++; }
   // These are precisely the original frame 3 sound setup operations.
   _root.musictemp1 = _root.createEmptyMovieClip("sound510",510);
   _root.music111 = new Sound(_root.musictemp1);
   _root.music111.attachSound("music111");
   _root.musictemp2 = _root.createEmptyMovieClip("sound511",511);
   _root.music222 = new Sound(_root.musictemp2);
   _root.music222.attachSound("music222");
   _root.musictemp3 = _root.createEmptyMovieClip("sound512",512);
   _root.music333 = new Sound(_root.musictemp3);
   _root.music333.attachSound("music333");
   _root.musictemp4 = _root.createEmptyMovieClip("sound513",513);
   _root.music444 = new Sound(_root.musictemp4);
   _root.music444.attachSound("music444");
   _root.musictemp5 = _root.createEmptyMovieClip("sound514",514);
   _root.music555 = new Sound(_root.musictemp5);
   _root.music555.attachSound("music555");
   var colors = [2,5,8,10];
   var total = _root.__netInt(config.players,2,2,4);
   idx = 0;
   while(idx < 4)
   {
      var prefix = "p" + (idx+1);
      var profile = config.profiles == undefined || config.profiles[idx] == undefined ? {} : config.profiles[idx];
      _root[prefix+"name"] = profile.name == undefined ? "Player " + (idx+1) : String(profile.name);
      _root[prefix+"color"] = _root.__netInt(profile.color,colors[idx],1,10);
      _root[prefix+"shirt"] = _root.__netInt(profile.shirt,1,1,15);
      _root[prefix+"hat"] = _root.__netInt(profile.hat,1,1,24);
      _root[prefix+"gun"] = _root.__netInt(profile.gun,1,1,6);
      _root[prefix+"perk"] = _root.__netInt(profile.perk,7,1,9);
      _root[prefix+"ptype"] = idx < total ? 1 : 0;
      _root[prefix+"team"] = idx+1;
      idx++;
   }
   _root.campaignmode = false;
   _root.campaignlevel = -1;
   _root.gotomenu = false;
   _root.gototest = false;
   _root.teamgame = false;
   _root.gamewin = false;
   // Original custom-game mode numbers: 1 = Last Man Standing, 4 = Gun Game.
   _root.gamemode = String(config.mode) == "gun-game" ? 4 : 1;
   _root.totallives = _root.__netInt(config.lives,10,1,99);
   _root.mapnumber = _root.__netInt(config.map,1,1,12);
   _root.crateON = true;
   _root.powerON = true;
   _root._x = 0;
   _root._y = 0;
   _root._xscale = 100;
   _root._yscale = 100;
   _root.gotoAndStop(10);
   return true;
};
// Lobby-only renderer. It opens the original four-player customization screen,
// then isolates its first player movie clip so the website can show the exact
// in-game character instead of maintaining a second approximation of the art.
_root.__netPreviewApply = function()
{
   var panel = _root.menup;
   var menu = panel == undefined ? undefined : panel.menu1;
   var player = menu == undefined ? undefined : menu.player;
   if(player == undefined) return false;
   if(_root.__netPreviewOriginal == undefined)
   {
      _root.__netPreviewOriginal = {panelX:panel._x,panelY:panel._y,menuX:menu._x,menuY:menu._y,playerX:player._x,playerY:player._y,playerScaleX:player._xscale,playerScaleY:player._yscale};
   }
   var key;
   for(key in _root)
   {
      if(typeof(_root[key]) == "movieclip" && _root[key]._parent == _root) _root[key]._visible = key == "menup";
   }
   for(key in panel)
   {
      if(typeof(panel[key]) == "movieclip" && panel[key]._parent == panel) panel[key]._visible = key == "menu1";
   }
   for(key in menu)
   {
      if(typeof(menu[key]) == "movieclip" && menu[key]._parent == menu) menu[key]._visible = key == "player";
   }
   panel._visible = true;
   menu._visible = true;
   player._visible = true;
   panel.setMask(null);
   menu.setMask(null);
   player.setMask(null);
   delete panel.onEnterFrame;
   delete menu.onEnterFrame;
   panel._x = 0;
   panel._y = 0;
   panel._xscale = 100;
   panel._yscale = 100;
   menu._x = 0;
   menu._y = 0;
   menu._xscale = 100;
   menu._yscale = 100;
   player._x = 450;
   player._y = 345;
   player._xscale = 190;
   player._yscale = 190;
   var profile = _root.__netPreviewProfile;
   var color = _root.__netInt(profile.color,1,1,10);
   player.head.gotoAndStop(color + 1);
   player.body.gotoAndStop(color + 1);
   player.leg1.leg.gotoAndStop(color + 1);
   player.leg2.leg.gotoAndStop(color + 1);
   player.hand2.hand.gotoAndStop(color + 1);
   player.gundisplayhand.gotoAndStop(color + 1);
   player.shirt.gotoAndStop(_root.__netInt(profile.shirt,1,1,15));
   player.hat.gotoAndStop(_root.__netInt(profile.hat,1,1,24));
   player.eyes.gotoAndStop(_root.__netInt(profile.hat,1,1,24));
   player.gundisplay.gotoAndStop(1);
   return true;
};
_root.netPreviewStart = function(profile)
{
   _root.__netPreviewProfile = profile == undefined ? {} : profile;
   _root.savedata2 = {data:{filled:true,musicON:false,soundON:false,def_quality:2,controlarray:_root.__netControls}};
   _root.gotoAndStop(9);
   _root.__netPreviewTimer = setInterval(_root.__netPreviewPoll,30);
   return true;
};
_root.__netPreviewPoll = function()
{
   if(_root.menup != undefined && _root.menup.menu1 != undefined && _root.menup.menu1.player == undefined)
   {
      _root.menup.menu1.gotoAndStop(3);
   }
   if(!_root.__netPreviewApply()) return;
   clearInterval(_root.__netPreviewTimer);
   _root.__netPreviewTimer = undefined;
   flash.external.ExternalInterface.call("netPreviewReady");
};
_root.netPreviewUpdate = function(profile)
{
   _root.__netPreviewProfile = profile == undefined ? {} : profile;
   return _root.__netPreviewApply();
};
_root.netPreviewDebug = function()
{
   var panel = _root.menup;
   var menu = panel == undefined ? undefined : panel.menu1;
   var player = menu == undefined ? undefined : menu.player;
   var bounds = player == undefined ? undefined : player.getBounds(_root);
   return {timeline:_root._currentframe,panel:panel != undefined,panelFrame:panel == undefined ? -1 : panel._currentframe,panelX:panel == undefined ? 0 : panel._x,panelY:panel == undefined ? 0 : panel._y,menu:menu != undefined,menuFrame:menu == undefined ? -1 : menu._currentframe,menuX:menu == undefined ? 0 : menu._x,menuY:menu == undefined ? 0 : menu._y,player:player != undefined,playerX:player == undefined ? 0 : player._x,playerY:player == undefined ? 0 : player._y,playerAlpha:player == undefined ? 0 : player._alpha,playerVisible:player == undefined ? false : player._visible,colorFrame:player == undefined ? -1 : player.head._currentframe,shirtFrame:player == undefined ? -1 : player.shirt._currentframe,hatFrame:player == undefined ? -1 : player.hat._currentframe,bounds:bounds,original:_root.__netPreviewOriginal,timer:_root.__netPreviewTimer};
};
_root.__netScalars = function(mc)
{
   var result = {x:mc._x,y:mc._y,scaleX:mc._xscale,scaleY:mc._yscale,rotation:mc._rotation,alpha:mc._alpha,visible:mc._visible,timeline:mc._currentframe};
   for(var key in mc)
   {
      var kind = typeof(mc[key]);
      if(key.substr(0,5) != "__net" && (kind == "number" || kind == "boolean" || kind == "string")) result[key] = mc[key];
   }
   return result;
};
_root.__netHashText = function(text)
{
   var n = 0;
   while(n < text.length)
   {
      _root.__netHash = (_root.__netHash * 131 + text.charCodeAt(n)) % 2147483647;
      n++;
   }
};
_root.__netHashClip = function(mc,depth)
{
   if(depth > 8) return;
   _root.__netHashText("clip:" + mc._name + ":" + mc.getDepth() + ":");
   var scalar = _root.__netScalars(mc);
   var keys = [];
   var key;
   for(key in scalar) keys.push(key);
   keys.sort();
   var n = 0;
   while(n < keys.length)
   {
      key = keys[n];
      _root.__netHashText(key + "=" + String(scalar[key]) + ";");
      n++;
   }
   keys = [];
   for(key in mc)
   {
      if(typeof(mc[key]) == "movieclip" && mc[key]._parent == mc && mc[key]._name == key) keys.push(key);
   }
   keys.sort();
   n = 0;
   while(n < keys.length)
   {
      _root.__netHashClip(mc[keys[n]],depth+1);
      n++;
   }
};
_root.netTickState = function()
{
   return {frame:_root.__netFrame,ticks:_root.__netTicks,timeline:_root._currentframe};
};
_root.netDebugInput = function()
{
   return {masks:_root.__netMasks,up:Key.isDown(38),right:Key.isDown(39),shoot:Key.isDown(219),bomb:Key.isDown(221),mathBound:Math.random == _root.__netFloat,seed:_root.__netSeed};
};
_root.netState = function()
{
   var result = {frame:_root.__netFrame,ticks:_root.__netTicks,timeline:_root._currentframe,rng:_root.__netSeed,gamewin:_root.gamewin,gamewincountdown:_root.gamewincountdown,paused:_root.GAMEPAUSED,map:_root.mapnumber,mode:_root.gamemode,timer:getTimer(),players:[],profiles:[],nameFields:[]};
   var p = 1;
   while(p <= 4)
   {
      var player = _root["player" + p];
      result.players.push(player == undefined ? null : _root.__netScalars(player));
      result.profiles.push({name:_root["p"+p+"name"],color:_root["p"+p+"color"],shirt:_root["p"+p+"shirt"],hat:_root["p"+p+"hat"]});
      var nameField = player == undefined || player.nametag == undefined ? undefined : player.nametag.nametext;
      result.nameFields.push(nameField == undefined ? null : {text:nameField.text,embedFonts:nameField.embedFonts,font:nameField.getTextFormat().font,textWidth:nameField.textWidth});
      p++;
   }
   _root.__netHash = 1;
   _root.__netHashClip(_root,0);
   result.checksum = _root.__netHash;
   result.entities = 0;
   for(var key in _root)
   {
      if(typeof(_root[key]) == "movieclip" && _root[key]._parent == _root && _root[key]._name == key) result.entities++;
   }
   return result;
};
flash.external.ExternalInterface.addCallback("netStart",_root,_root.netStart);
flash.external.ExternalInterface.addCallback("netInput",_root,_root.netInput);
flash.external.ExternalInterface.addCallback("netState",_root,_root.netState);
flash.external.ExternalInterface.addCallback("netTickState",_root,_root.netTickState);
flash.external.ExternalInterface.addCallback("netDebugInput",_root,_root.netDebugInput);
flash.external.ExternalInterface.addCallback("netPreviewStart",_root,_root.netPreviewStart);
flash.external.ExternalInterface.addCallback("netPreviewUpdate",_root,_root.netPreviewUpdate);
flash.external.ExternalInterface.addCallback("netPreviewDebug",_root,_root.netPreviewDebug);
stop();
flash.external.ExternalInterface.call("netReady");
