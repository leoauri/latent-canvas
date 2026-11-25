Class {
	#name : #SRRedawLatentStrip,
	#superclass : #Object,
	#instVars : [
		'mesh',
		'texture',
		'firstFrame',
		'frameCount',
		'frameWidth',
		'dims'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip class >> frames: frames from: start count: n frameWidth: aWidth depth: aDepth projection: aProjection [
	^ self new setFrames: frames from: start count: n frameWidth: aWidth depth: aDepth projection: aProjection
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> dims [
	^ dims
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> frameWidth [
	^ frameWidth
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 13:54'
}
SRRedawLatentStrip >> length [
	^ frameCount * frameWidth
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> mesh [
	^ mesh
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> meshDepth: aDepth [
	"A box per frame. z is 0 or 1: the vertex shader scales it to the frame's height. Colour alpha tells the faces apart: top 255, sides 128, ends 0."
	| vertices normals texcoords colors indices n quad |
	vertices := SRMeshSourceRaw verticesClass new: frameCount * 60.
	normals := SRMeshSourceRaw normalsClass new: frameCount * 60.
	texcoords := SRMeshSourceRaw texcoordsClass new: frameCount * 40.
	colors := SRMeshSourceRaw colorsClass new: frameCount * 80.
	indices := SRMeshSourceRaw indicesClass new: frameCount * 30.
	n := 0.
	quad := [:corners :normal :code :u |
		#(0 1 2 0 2 3) doWithIndex: [:offset :k | indices at: n // 4 * 6 + k put: n + offset].
		corners do: [:corner |
			1 to: 3 do: [:k |
				vertices at: n * 3 + k put: (corner at: k) asFloat.
				normals at: n * 3 + k put: (normal at: k) asFloat].
			texcoords at: n * 2 + 1 put: u; at: n * 2 + 2 put: (corner at: 4) asFloat.
			colors at: n * 4 + 4 put: code.
			n := n + 1]].
	0 to: frameCount - 1 do: [:i | | x0 x1 y0 y1 u |
		x0 := i * frameWidth.
		x1 := i + 1 * frameWidth.
		y0 := aDepth / -2.
		y1 := aDepth / 2.
		u := i + 0.5.
		quad value: {{x0. y0. 1. 0}. {x1. y0. 1. 0}. {x1. y1. 1. 1}. {x0. y1. 1. 1}} value: #(0 0 1) value: 255 value: u.
		quad value: {{x0. y0. 0. 0}. {x1. y0. 0. 0}. {x1. y0. 1. 1}. {x0. y0. 1. 1}} value: #(0 -1 0) value: 128 value: u.
		quad value: {{x1. y1. 0. 0}. {x0. y1. 0. 0}. {x0. y1. 1. 1}. {x1. y1. 1. 1}} value: #(0 1 0) value: 128 value: u.
		quad value: {{x0. y1. 0. 0.5}. {x0. y0. 0. 0.5}. {x0. y0. 1. 0.5}. {x0. y1. 1. 0.5}} value: #(-1 0 0) value: 0 value: u.
		quad value: {{x1. y0. 0. 0.5}. {x1. y1. 0. 0.5}. {x1. y1. 1. 0.5}. {x1. y0. 1. 0.5}} value: #(1 0 0) value: 0 value: u].
	^ SRMesh withSource: (SRMeshSourceRaw new
		editDo: [:s | s vertices: vertices; normals: normals; texcoords: texcoords; colors: colors; indices: indices];
		yourself)
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> offset [
	^ firstFrame - 1 * frameWidth
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> setFrames: frames from: start count: n frameWidth: aWidth depth: aDepth projection: aProjection [
	firstFrame := start.
	frameCount := n.
	frameWidth := aWidth.
	dims := frames first size.
	texture := self textureFor: frames projection: aProjection.
	mesh := self meshDepth: aDepth.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> texture [
	^ texture
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> textureFor: frames projection: aProjection [
	"One row per frame: the vector, its length, its movement, the page colour."
	| width floats previous |
	width := dims + 5.
	floats := Float32Array new: width * frameCount.
	previous := firstFrame > 1 ifTrue: [frames at: firstFrame - 1].
	0 to: frameCount - 1 do: [:row | | f base |
		f := frames at: firstFrame + row.
		base := row * width.
		floats replaceFrom: base + 1 to: base + dims with: f startingAt: 1.
		floats at: base + dims + 1 put: ((f dot: f) / dims) sqrt.
		floats at: base + dims + 2 put: (previous
			ifNil: [0.0]
			ifNotNil: [| delta | delta := f - previous. ((delta dot: delta) / dims) sqrt]).
		1 to: 3 do: [:k | floats at: base + dims + 2 + k put: 128 + (112 * ((aProjection at: k) dot: f) tanh) / 255].
		previous := f].
	^ SRTexture withSource: (SRRedawLatentTextureSource floats: floats width: width height: frameCount)
]

{
	#category : #releasing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentStrip >> unload [
	mesh unload.
	texture unload.
]
