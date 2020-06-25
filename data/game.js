let bird;
let gravity = 1;

let pipes = [];

let soundEffects = [];

function preload() {
    LoadSounds();
}

function setup(){
    //frameRate(60);
    createCanvas(windowWidth, windowHeight);
    start();
}

function LoadSounds(){
    soundEffects.push(loadSound('data/sound/sfx_point.wav'));
    soundEffects.push(loadSound('data/sound/sfx_die.wav'));
    soundEffects.push(loadSound('data/sound/sfx_hit.wav'));
    soundEffects.push(loadSound('data/sound/sfx_swooshing.wav'));
    soundEffects.push(loadSound('data/sound/sfx_wing.wav'));
}

function start(){
    pipes = [];
    bird = new Bird(100,250);
    let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
    for (let i = 1; i <= pipeCount + 2; i++) {
        new Pipe(width + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
    }
}



function draw(){
    push();
        background(color(BG_COLOR));
    pop();

    pipes.forEach(element => {
        element.show();
    });

    push();
        noStroke();
        fill(color(GROUND_COLOR));
        rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
    pop();


    bird.show();


    push();
        textAlign(CENTER);
        fill(255);
        textSize(60);
        text(bird.point, width/2,60);
    pop();

    update();
}

function update() {
    bird.update();
    if(bird.live){
        pipes.forEach(element => {
            element.update();
            if(element.pos.x <= bird.pos.x + PIPE_WIDTH && element.pos.x >= bird.pos.x - PIPE_WIDTH){
                if (element.isCollide(bird)){
                    bird.die();
                }
                if (element.pos.x <= bird.pos.x && element.hasPoint){
                    element.hasPoint = false;
                    try { soundEffects[0].play(); } catch(e) {}
                    bird.point++;
                }
            }
        });
    }
}

function mouseReleased(){
    if (bird.live){
        bird.jump();
    }else{
        start();
    }
}

function keyReleased(){
    if(keyCode == 32){ //32 for space bar
        if (bird.live){
            bird.jump();
        }else{
            start();
        }
    }
}





function isInside(pos, rect){
    return pos.x >= rect.x1 && pos.x <= rect.x2  &&  pos.y >= rect.y1 && pos.y <= rect.y2;
}

//http://www.jeffreythompson.org/collision-detection/circle-rect.php
function circleRect(bird, rectV) {
    // temporary variables to set edges for testing
    let testX = bird.pos.x;
    let testY = bird.pos.y;
  
    // which edge is closest?
    if (bird.pos.x < rectV.x1)       testX = rectV.x1;      // test left edge
    else if (bird.pos.x > rectV.x2)  testX = rectV.x2;   // right edge
    if (bird.pos.y < rectV.y1)       testY = rectV.y1;      // top edge
    else if (bird.pos.y > rectV.y2)  testY = rectV.y2;   // bottom edge
  
    // get distance from closest edges
    let distX = bird.pos.x - testX;
    let distY = bird.pos.y - testY;
    let distance = sqrt((distX*distX) + (distY*distY));
    // if the distance is less than the bird.radius, collision!
    if(DEBUG_MODE){
        pop();
            fill(0);
            rect(rectV.x1,rectV.y1,rectV.x2-rectV.x1,abs(rectV.y1-rectV.y2));
            ellipse(bird.pos.x, bird.pos.y, bird.radius-10, bird.radius-10);
        push();
    }
    if (distance <= bird.radius-10)
        return true;
    return false;
}