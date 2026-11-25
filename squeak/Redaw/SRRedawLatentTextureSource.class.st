Class {
	#name : #SRRedawLatentTextureSource,
	#superclass : #SRTextureSource,
	#instVars : [
		'floats',
		'width',
		'height'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentTextureSource class >> floats: aFloat32Array width: aWidth height: aHeight [
	^ self new setFloats: aFloat32Array width: aWidth height: aHeight
]

{
	#category : #rendering,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentTextureSource >> createInternalTexture [
	"Float textures are not filterable on GLES 3: the shader reads them with texelFetch."
	SRRenderer assertContext.
	internalTexture ifNotNil: [^ internalTexture].
	internalTexture := RlTexture new
		id: (Raylib
			rlLoadTextureData: floats
			width: width
			height: height
			format: RlPixelFormat pixelformatUncompressedR32
			mipmapCount: 1);
		width: width;
		height: height;
		format: RlPixelFormat pixelformatUncompressedR32;
		mipmaps: 1.
	Raylib setTextureFilterTexture: internalTexture filter: RlTextureFilter textureFilterPoint.
	^ internalTexture
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentTextureSource >> setFloats: aFloat32Array width: aWidth height: aHeight [
	floats := aFloat32Array.
	width := aWidth.
	height := aHeight.
]
