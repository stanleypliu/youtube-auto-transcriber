console.log('YouTube Auto Transcriber content script loaded')

let recordingIndicator: HTMLElement | null = null
let mediaRecorder: MediaRecorder | null = null
let audioStream: MediaStream | null = null

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message)
  
  if (message.type === 'ping') {
    sendResponse({ success: true, message: 'Content script is ready' })
  } else if (message.type === 'recordingState') {
    updateRecordingIndicator(message.isRecording)
    sendResponse({ success: true })
  } else if (message.type === 'startRecording') {
    console.log('Starting screen capture recording...')
    startScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'stopRecording') {
    console.log('Stopping screen capture recording...')
    stopScreenCapture()
    sendResponse({ success: true })
  } else if (message.type === 'getRecordingState') {
    const isRecording = mediaRecorder?.state === 'recording'
    sendResponse({ isRecording })
  }
  
  return true
})

async function startScreenCapture() {
  try {
    console.log('Requesting screen capture with audio...')
    
    // Show instruction to user
    showInstructionModal()
    
    // Use getDisplayMedia to capture screen with audio
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,  // Required for getDisplayMedia
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 44100
      }
    })
    
    console.log('Screen capture successful, tracks:', stream.getTracks().map(t => ({ 
      kind: t.kind, 
      enabled: t.enabled, 
      label: t.label 
    })))
    
    // Check if we have audio
    const audioTracks = stream.getAudioTracks()
    const videoTracks = stream.getVideoTracks()
    
    console.log('Audio tracks:', audioTracks.length)
    console.log('Video tracks:', videoTracks.length)
    
    if (audioTracks.length === 0) {
      throw new Error('No audio captured. Please make sure to check "Share tab audio" when prompted.')
    }
    
    // Create audio-only stream
    const audioOnlyStream = new MediaStream(audioTracks)
    
    // Set up MediaRecorder
    const supportedTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ]
    
    let selectedType = supportedTypes.find(type => MediaRecorder.isTypeSupported(type))
    console.log('Selected audio type:', selectedType)
    
    const options: MediaRecorderOptions = {
      audioBitsPerSecond: 128000
    }
    
    if (selectedType) {
      options.mimeType = selectedType
    }
    
    mediaRecorder = new MediaRecorder(audioOnlyStream, options)
    
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        console.log('Audio chunk available:', event.data.size, 'bytes')
        
        try {
          // Convert blob to base64 before sending to background script
          const base64Data = await blobToBase64(event.data)
          
          // Send to background script for processing
          chrome.runtime.sendMessage({
            type: 'audioChunk',
            audioData: base64Data,
            size: event.data.size,
            mimeType: event.data.type
          })
        } catch (error) {
          console.error('Failed to convert audio chunk to base64:', error)
        }
      }
    }
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event)
      chrome.runtime.sendMessage({
        type: 'recordingError',
        error: 'MediaRecorder error occurred'
      })
    }
    
    mediaRecorder.onstop = () => {
      console.log('MediaRecorder stopped')
    }
    
    // Start recording in 5-second chunks
    mediaRecorder.start(5000)
    audioStream = stream
    
    // Stop video tracks to save resources (we only need audio)
    videoTracks.forEach(track => track.stop())
    
    // Hide instruction modal
    hideInstructionModal()
    
    console.log('Audio recording started successfully')
    chrome.runtime.sendMessage({ type: 'recordingStarted' })
    
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

function stopScreenCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
    mediaRecorder = null
  }
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop())
    audioStream = null
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

// Helper function to convert blob to base64
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'contentScriptReady' })
