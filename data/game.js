let buttons = [];
let birds = [];
let deadBirds = [];
let pipes = [];
let nextPipe;
let soundEffects = [];

let bestScore = 0;

let geniusBirdJson;
let geniusBirdBrain;
let geniusBird;

let player;

let scene = 2;

function preload(){
    geniusBirdJson = loadJSON("data\\birdBrain_5-10-10-1_ai.json");
    console.log(geniusBirdJson);
}

function setup(){
    geniusBirdBrain = NeuralNetwork.deserialize(geniusBirdJson);
    console.log(geniusBirdBrain);
    
    let cnv;
    if(windowWidth<1000)
        cnv = createCanvas(windowWidth, windowHeight);
    else
        cnv = createCanvas(375, 812);
    let x = (windowWidth - width) / 2;
    let y = (windowHeight - height) / 2;
    cnv.position(x, y);

    new Button(50, height-GROUND_HEIGHT/2, 75, 30, "PLAY", "#EAEAEA", function(){console.log("Player Play");});
    new Button(135, height-GROUND_HEIGHT/2, 75, 30, "AI", "#EAEAEA", function(){console.log("AI Play");});
    new Button(220, height-GROUND_HEIGHT/2, 75, 30, "TEACH", "#EAEAEA", function(){console.log("Teach Play");});

    start();
}

function start(){
    pipes = [];
    bestScore = 0;
    
    let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
    
    for (let i = 1; i <= pipeCount + 2; i++) {
        new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
    }
    nextPipe = pipes[0];

    if (scene == 0){
        bestBird = new Bird(BIRD_X, 100, geniusBirdBrain);
    } else if(scene == 1){
        setPopulation();
    } else if(scene == 2){
        player = new Bird(BIRD_X, 100, null, true); 
    }
}

function draw(){
    /*for (let i = 0; i < b && a; i++) {  
        update();
    }*/
    update();

    push();
        background(color(BG_COLOR));
    pop();
    
    pipes.forEach(pipe => {
        pipe.show();
        //nextPipe != null ? nextPipe.debugShow() : null;
    });

    push();
        noStroke();
        fill(color(GROUND_COLOR));
        rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
    pop();

    birds.forEach(bird => {
        bird.show();
    });

    buttons.forEach(button => {
        button.show();
    });

    push();
        textAlign(CENTER);
        fill(255);
        textSize(60);
        text(birds[0].point, width/2,60);
    pop();
}

function update() {
    birds.forEach(bird => {
        bird.update();
        if (nextPipe.isCollide(bird)){
            bird.die();
        }
        if (nextPipe.pos.x <= bird.pos.x){
            bird.fitness+=10000;
        }
    });

    let nextPipeSelected = false; //this loop start looping from the left side so 
    pipes.forEach(pipe => {
        pipe.update();      
        if (!nextPipeSelected){
            if(!(pipe.bottomPipe.x2 < (BIRD_X - BIRD_R/2))){ //if two pipe in this area
                if(pipe.bottomPipe.x1 < (BIRD_X + PIPE_BETWEEN)){ //don't select further one because birds still can touch closest pipe
                    nextPipe =  pipe;
                    nextPipeSelected = true;
                }
            }
        }
    });

    if(birds.length == 0){
        //console.log(deadBirds);
        start();
    }
}


function mouseReleased(){
    if(mouseY >= height-GROUND_HEIGHT){
        buttons.forEach(button => {
            if(isInside({x:mouseX, y:mouseY}, button.rect)){
                button.func();
            }
        });
        return;
    }
    if(scene==2){
        if (player.live){
            player.jump();
        }else{
            start();
        }
    }
}

/*
function keyReleased(){
    if(keyCode == 32){ //32 for space bar
        if (bird.live){
            bird.jump();
        }else{
            start();
        }
    }
}
*/


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