// Match object-fit: cover, so decoding uses exactly the visible camera frame.
export function inventoryScanCrop(videoWidth,videoHeight,frameWidth,frameHeight){
 if(![videoWidth,videoHeight,frameWidth,frameHeight].every(value=>Number.isFinite(value)&&value>0))return null;
 const ratio=frameWidth/frameHeight;
 const width=Math.min(videoWidth,videoHeight*ratio),height=Math.min(videoHeight,videoWidth/ratio);
 return{x:(videoWidth-width)/2,y:(videoHeight-height)/2,width,height};
}
