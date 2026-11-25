"
Where a map looks, as one rectangle on the canvas: a unit box scaled to the map's region, translucent so the clips stay visible, outlined in the map's colour.
"
Class {
	#name : #SRRedawMapMarker,
	#superclass : #SRObject,
	#instVars : [
		'color'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:42'
}
SRRedawMapMarker >> color: aColor [
	color := aColor.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:56'
}
SRRedawMapMarker >> rect: aRectangle [
	"In canvas coordinates; lies flat on the canvas, just above it. Not Rectangle>>center: it divides with //, and these are metres."
	| middle |
	middle := aRectangle origin + aRectangle corner / 2.
	self
		translation: middle x @ middle y @ 1cm;
		scale: aRectangle width @ aRectangle height @ 1cm.
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 14:42'
}
SRRedawMapMarker >> renderOn: aRenderer [
	"Translucent: the depth mask is batch state, so flush before switching it. A faint fill, so a map showing the whole canvas does not tint it."
	Raylib rlDrawRenderBatchActive; rlDisableDepthMask.
	Raylib beginBlendMode: 0.
	[aRenderer withTransform: self globalTransform do: [
		Raylib
			drawCubePosition: aRenderer class rlVectorZero width: 1 height: 1 length: 1 color: (aRenderer class rlColorFor_1: (color alpha: 0.06));
			drawCubeWiresPosition: aRenderer class rlVectorZero width: 1 height: 1 length: 1 color: (aRenderer class rlColorFor_2: color)]]
		ensure: [Raylib endBlendMode; rlDrawRenderBatchActive; rlEnableDepthMask]
]
