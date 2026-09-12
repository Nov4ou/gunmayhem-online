// Append this extension before the original bridge callback registrations.
// The original netState, __netScalars, __netHashClip and polynomial hash remain
// intact. The fast callback uses the exact same traversal and string formatting,
// but transfers its complete hash input to JavaScript for the arithmetic loop.
_root.__netOriginalHashText = _root.__netHashText;
_root.__netCollectHashText = function(text)
{
   _root.__netHashChunks.push(text);
};
_root.netCheckState = function()
{
   _root.__netHashChunks = [];
   _root.__netHashText = _root.__netCollectHashText;
   var result = _root.netState();
   _root.__netHashText = _root.__netOriginalHashText;
   result.chunks = _root.__netHashChunks;
   _root.__netHashChunks = undefined;
   delete result.checksum;
   return result;
};
flash.external.ExternalInterface.addCallback("netCheckState",_root,_root.netCheckState);
