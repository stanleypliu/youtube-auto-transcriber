console.log('YouTube Auto Transcriber content script loaded')

// Add more debugging to verify script is working
console.log('Content script environment check:')
console.log('- Window location:', window.location.href)
console.log('- Document ready state:', document.readyState)
console.log('- Chrome runtime available:', typeof chrome !== 'undefined' && !!chrome.runtime)
console.log('- Content script timestamp:', new Date().toISOString())

let recordingIndicator: HTMLElement | null = null
let mediaRecorder: MediaRecorder | null = null
let audioStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.readAsDataURL(blob)
  })
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('=== CONTENT SCRIPT MESSAGE RECEIVED ===')
  console.log('Content script received message:', message)
  console.log('Sender:', sender)
  console.log('Message type:', message.type)
  
  if (message.type === 'ping') {
    console.log('Responding to ping')
    sendResponse({ success: true, message: 'Content script is ready' })
  } else if (message.type === 'recordingState') {
    console.log('Updating recording indicator:', message.isRecording)
    updateRecordingIndicator(message.isRecording)
    sendResponse({ success: true })
  } else if (message.type === 'startRecording') {
    console.log('🎬 START RECORDING MESSAGE RECEIVED - Starting screen capture...')
    startScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'stopRecording') {
    console.log('⏹️ STOP RECORDING MESSAGE RECEIVED - Stopping screen capture...')
    stopScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'getRecordingState') {
    const isRecording = mediaRecorder?.state === 'recording'
    console.log('Getting recording state:', isRecording)
    sendResponse({ isRecording })
  } else {
    console.log('❌ Unknown message type:', message.type)
  }
  
  console.log('=== END MESSAGE HANDLING ===')
  return true
})

async function startScreenCapture() {
  try {
    console.log('🎬 === STARTING SCREEN CAPTURE ===')
    console.log('Requesting screen capture with audio...')
    
    // Show instruction to user
    showInstructionModal()
    console.log('Instruction modal shown')
    
    // Use getDisplayMedia to capture screen with audio
    console.log('Calling navigator.mediaDevices.getDisplayMedia...')
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // Required for getDisplayMedia
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100
      }
    })
    
    console.log('✅ Screen capture successful!')
    console.log('Stream tracks:', stream.getTracks().map(t => ({ 
      kind: t.kind, 
      enabled: t.enabled, 
      label: t.label,
      settings: t.getSettings ? t.getSettings() : 'N/A'
    })))
    
    // Check if we have audio
    const audioTracks = stream.getAudioTracks()
    const videoTracks = stream.getVideoTracks()
    
    console.log(`Audio tracks found: ${audioTracks.length}`)
    console.log(`Video tracks found: ${videoTracks.length}`)
    
    if (audioTracks.length === 0) {
      throw new Error('No audio captured. Please make sure to check "Share tab audio" when prompted.')
    }

    // Log audio track settings
    audioTracks.forEach((track, index) => {
      console.log(`Audio track ${index} settings:`, track.getSettings())
      console.log(`Audio track ${index} capabilities:`, track.getCapabilities())
    })
    
    // Create audio-only stream
    const audioOnlyStream = new MediaStream(audioTracks)
    console.log('Created audio-only stream from', audioTracks.length, 'audio tracks')
    
    // Set up audio analysis
    try {
      console.log('Setting up audio context...')
      audioContext = new AudioContext({ sampleRate: 44100 })
      const source = audioContext.createMediaStreamSource(audioOnlyStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      
      // Start monitoring audio levels
      monitorAudioLevels()
      
      console.log('✅ Audio context created successfully, sample rate:', audioContext.sampleRate)
    } catch (error) {
      console.error('❌ Failed to create audio context:', error)
    }
    
    // Use a more explicit WebM configuration that's compatible with Google Speech API
    console.log('Configuring MediaRecorder for WebM audio...')
    
    // Check what formats are supported
    const supportedTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/webm;codecs=vorbis'
    ]
    
    let selectedType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type))
    console.log('Supported audio types:', supportedTypes.map(type => `${type}: ${MediaRecorder.isTypeSupported(type) ? 'YES' : 'NO'}`))
    console.log('Selected audio type:', selectedType)
    
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: 128000
    }
    
    if (selectedType) {
      options.mimeType = selectedType
    }
    
    console.log('MediaRecorder options:', options)
    
    console.log('Creating MediaRecorder with audio stream...')
    mediaRecorder = new MediaRecorder(audioOnlyStream, options)
    console.log('✅ MediaRecorder created successfully')
    
    mediaRecorder.ondataavailable = async (event) => {
      console.log(`🎵 === MEDIARECORDER DATA AVAILABLE ===`)
      console.log(`Event data size: ${event.data.size} bytes`)
      console.log(`Event data type: ${event.data.type}`)
      console.log(`Event timestamp: ${event.timeStamp}`)
      
      if (event.data.size > 0) {
        console.log(`=== AUDIO CHUNK CAPTURED ===`)
        console.log(`Audio chunk available: ${event.data.size} bytes`)
        console.log(`Audio chunk type: ${event.data.type}`)
        console.log(`Audio chunk timestamp: ${event.timeStamp}`)
        
        try {
          // Don't try to convert to LINEAR16 - just send the original WebM data
          // This avoids the decoding errors entirely
          console.log('Converting blob to base64...')
          const base64Data = await blobToBase64(event.data)
          
          console.log(`Converted to base64: ${base64Data.length} characters`)
          console.log(`Base64 preview: ${base64Data.substring(0, 100)}...`)
          
          console.log('Sending audio chunk to background script...')
          chrome.runtime.sendMessage({
            type: 'audioChunk',
            audioData: base64Data,
            size: event.data.size,
            mimeType: event.data.type,
            encoding: 'WEBM_ORIGINAL',
            sampleRate: audioContext?.sampleRate || 44100
          })
          
          console.log(`✅ Audio chunk sent to background script`)
          
        } catch (error) {
          console.error('❌ Failed to process audio chunk:', error)
          
          // Last resort: try sending the original blob
          try {
            console.log('Trying fallback approach...')
            const base64Data = await blobToBase64(event.data)
            chrome.runtime.sendMessage({
              type: 'audioChunk',
              audioData: base64Data,
              size: event.data.size,
              mimeType: event.data.type,
              encoding: 'ORIGINAL'
            })
            console.log('Fallback audio chunk sent')
          } catch (fallbackError) {
            console.error('❌ Even fallback failed:', fallbackError)
          }
        }
        console.log(`=== END AUDIO CHUNK ===`)
      } else {
        console.warn('⚠️ Received empty audio chunk')
      }
      console.log(`🎵 === END MEDIARECORDER DATA ===`)
    }
    
    mediaRecorder.onerror = (event) => {
      console.error('❌ MediaRecorder error:', event)
      chrome.runtime.sendMessage({
        type: 'recordingError',
        error: 'MediaRecorder error occurred'
      })
    }
    
    mediaRecorder.onstop = () => {
      console.log('⏹️ MediaRecorder stopped')
    }
    
    mediaRecorder.onstart = () => {
      console.log('✅ MediaRecorder started successfully')
    }
    
    // Start recording in 10-second chunks
    console.log('🎬 Starting MediaRecorder with 10-second chunks...')
    mediaRecorder.start(10000)
    console.log('✅ MediaRecorder.start() called')
    
    audioStream = stream
    console.log('Audio stream saved')
    
    // Stop video tracks to save resources (we only need audio)
    videoTracks.forEach(track => track.stop())
    console.log('Video tracks stopped')
    
    // Hide instruction modal
    hideInstructionModal()
    console.log('Instruction modal hidden')
    
    console.log('🎉 === SCREEN CAPTURE SETUP COMPLETE ===')
    console.log('Audio recording started successfully')
    chrome.runtime.sendMessage({ type: 'recordingStarted' })
    console.log('recordingStarted message sent to background')
    
    // Handle stream end (user stops sharing)
    audioTracks.forEach(track => {
      track.addEventListener('ended', () => {
        console.log('Audio track ended (user stopped sharing)')
        stopScreenCapture()
      })
    })
    
  } catch (error) {
    console.error('Failed to start screen capture:', error)
    hideInstructionModal()
    
    let errorMessage = error.message
    if (error.name === 'NotAllowedError') {
      errorMessage = 'Screen sharing was denied. Please allow screen sharing and make sure to select "Share tab audio".'
    } else if (error.name === 'NotFoundError') {
      errorMessage = 'No screen sharing source found. Please try again.'
    }
    
    chrome.runtime.sendMessage({
      type: 'recordingError',
      error: errorMessage
    })
  }
}

function monitorAudioLevels() {
  if (!analyser) return
  
  const bufferLength = analyser.frequencyBinCount
  const dataArray = new Uint8Array(bufferLength)
  
  function checkAudio() {
    if (!analyser) return
    
    analyser.getByteFrequencyData(dataArray)
    
    // Calculate average volume
    const average = dataArray.reduce((sum, value) => sum + value, 0) / bufferLength
    
    // Log audio levels every 5 seconds
    if (Math.random() < 0.1) { // ~10% chance each frame
      console.log(`Audio level: ${average.toFixed(2)}/255, non-zero frequencies: ${dataArray.filter(v => v > 0).length}/${bufferLength}`)
    }
    
    // Continue monitoring
    requestAnimationFrame(checkAudio)
  }
  
  checkAudio()
}

function stopScreenCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    mediaRecorder = null
  }
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop())
    audioStream = null
  }
  
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyser = null
  }
  
  hideInstructionModal()
  
  console.log('Audio recording stopped')
  chrome.runtime.sendMessage({ type: 'recordingStopped' })
}

function showInstructionModal() {
  // Remove existing modal if any
  hideInstructionModal()
  
  const modal = document.createElement('div')
  modal.id = 'transcriber-instruction-modal'
  modal.innerHTML = `
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif;
    ">
      <div style="
        background: white;
        padding: 30px;
        border-radius: 12px;
        max-width: 500px;
        text-align: center;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      ">
        <h2 style="margin: 0 0 20px 0; color: #1a73e8;">🎤 Audio Capture Required</h2>
        <p style="margin: 0 0 20px 0; color: #333; line-height: 1.5;">
          To transcribe this YouTube video, please:
        </p>
        <ol style="text-align: left; color: #333; line-height: 1.6; margin: 0 0 20px 0;">
          <li>In the sharing dialog, click <strong>"Tab"</strong> at the top</li>
          <li>Select the <strong>YouTube tab</strong> you want to transcribe</li>
          <li>Make sure to check <strong>"Share tab audio"</strong> at the bottom</li>
          <li>Click <strong>"Share"</strong></li>
        </ol>
        <div style="background: #f0f8ff; padding: 10px; border-radius: 6px; margin: 0 0 20px 0; font-size: 13px; color: #333;">
          <strong>💡 Tip:</strong> If you don't see "Tab" option, select "Entire screen" and still check "Share system audio"
        </div>
        <p style="margin: 0; color: #666; font-size: 14px;">
          The screen sharing dialog should appear shortly...
        </p>
      </div>
    </div>
  `
  
  document.body.appendChild(modal)
}

function hideInstructionModal() {
  const modal = document.getElementById('transcriber-instruction-modal')
  if (modal) {
    modal.remove()
  }
}

function updateRecordingIndicator(isRecording: boolean) {
  if (isRecording && !recordingIndicator) {
    recordingIndicator = document.createElement('div')
    recordingIndicator.innerHTML = '🎤 Recording Audio<br><small>Click to stop</small>'
    recordingIndicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #ea4335, #fbbc04);
      color: white;
      padding: 15px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: system-ui, -apple-system, sans-serif;
      animation: pulse 2s infinite;
      cursor: pointer;
      text-align: center;
      line-height: 1.3;
    `
    
    // Add CSS animation
    if (!document.querySelector('#transcriber-styles')) {
      const style = document.createElement('style')
      style.id = 'transcriber-styles'
      style.textContent = `
        @keyframes pulse {
          0% { transform: scale(1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
          50% { transform: scale(1.05); box-shadow: 0 6px 16px rgba(0,0,0,0.25); }
          100% { transform: scale(1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        }
      `
      document.head.appendChild(style)
    }
    
    // Click to stop recording
    recordingIndicator.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'stopRecording' })
    })
    
    document.body.appendChild(recordingIndicator)
    
  } else if (!isRecording && recordingIndicator) {
    recordingIndicator.remove()
    recordingIndicator = null
  }
}

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'contentScriptReady' })
